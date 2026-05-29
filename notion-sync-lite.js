/**
 * Notion Feeder lite: sync RSS title, link, cleaned content, and optional translation.
 *
 * Env: NOTION_API_TOKEN, NOTION_FEEDS_DATABASE_ID, NOTION_READER_DATABASE_ID
 * Optional:
 * - RUN_FREQUENCY (seconds, default 604800 = 7 days)
 * - SYNC_CONTENT=false to disable page body content
 * - UPDATE_EXISTING=false to skip backfilling existing pages with empty bodies
 * - TRANSLATE_TO=zh-CN to translate with an OpenAI-compatible API
 * - OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
 * - DEEPSEEK_API_KEY as a convenient OpenAI-compatible fallback
 */

const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/rss+xml, application/xml, text/xml, */*',
};

const parser = new Parser({
  timeout: 30000,
  headers: FETCH_HEADERS,
});

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const FEEDS_DB = process.env.NOTION_FEEDS_DATABASE_ID;
const READER_DB = process.env.NOTION_READER_DATABASE_ID;
const RUN_FREQUENCY = Number(process.env.RUN_FREQUENCY || 604800);
const SYNC_CONTENT = process.env.SYNC_CONTENT !== 'false';
const UPDATE_EXISTING = process.env.UPDATE_EXISTING !== 'false';
const CONTENT_CHAR_LIMIT = Number(process.env.CONTENT_CHAR_LIMIT || 6000);
const TRANSLATE_TO = process.env.TRANSLATE_TO || 'zh-CN';
const TRANSLATE_CHAR_LIMIT = Number(process.env.TRANSLATE_CHAR_LIMIT || 3500);
const FETCH_FULL_ARTICLE = process.env.FETCH_FULL_ARTICLE !== 'false';
const ARTICLE_MIN_CHARS = Number(process.env.ARTICLE_MIN_CHARS || 1200);
const BILINGUAL_PARAGRAPH_LIMIT = Number(process.env.BILINGUAL_PARAGRAPH_LIMIT || 16);

function getTranslatorConfig() {
  if (process.env.OPENAI_API_KEY) {
    return {
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    };
  }

  if (process.env.DEEPSEEK_API_KEY) {
    return {
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: 'https://api.deepseek.com/v1',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    };
  }

  return null;
}

function normalizeId(id) {
  return (id || '').replace(/-/g, '');
}

function substackRssHubUrl(feedUrl) {
  const match = feedUrl.match(/https?:\/\/([^.]+)\.substack\.com/i);
  if (!match) return null;
  return `https://rsshub.app/substack/${match[1]}`;
}

function candidateFeedUrls(feedUrl) {
  const urls = [feedUrl];
  const hub = substackRssHubUrl(feedUrl);
  if (hub && !urls.includes(hub)) urls.push(hub);
  return urls;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function htmlToText(value) {
  return decodeHtmlEntities(String(value || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getFeedItemContent(item) {
  const raw =
    item['content:encoded'] ||
    item.content ||
    item.description ||
    item.summary ||
    item['content:encoded'] ||
    item.contentSnippet ||
    '';

  return htmlToText(raw).slice(0, CONTENT_CHAR_LIMIT);
}

async function fetchArticleText(url) {
  if (!FETCH_FULL_ARTICLE || !url) return '';

  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    return htmlToText(article?.textContent || '').slice(0, CONTENT_CHAR_LIMIT);
  } catch (err) {
    console.error(`  WARN: full article fetch failed: ${err.message}`);
    return '';
  }
}

async function getOriginalText(item, link) {
  const rssText = getFeedItemContent(item);
  if (!FETCH_FULL_ARTICLE || rssText.length >= ARTICLE_MIN_CHARS) {
    return rssText;
  }

  const articleText = await fetchArticleText(link);
  return articleText.length > rssText.length ? articleText : rssText;
}

function splitIntoParagraphs(text, maxLength = 1800, maxBlocks = 40) {
  const blocks = [];
  const paragraphs = String(text || '')
    .split(/\n{2,}|\n-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    let rest = paragraph;
    while (rest.length > 0 && blocks.length < maxBlocks) {
      blocks.push(rest.slice(0, maxLength));
      rest = rest.slice(maxLength);
    }
    if (blocks.length >= maxBlocks) break;
  }

  return blocks;
}

function paragraphBlock(content) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: content.slice(0, 2000) } }],
    },
  };
}

function headingBlock(content) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: content.slice(0, 2000) } }],
    },
  };
}

function dividerBlock() {
  return { object: 'block', type: 'divider', divider: {} };
}

function calloutBlock(content, icon = '🌐') {
  return {
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: icon },
      rich_text: [{ type: 'text', text: { content: content.slice(0, 2000) } }],
    },
  };
}

async function translateText(text, context) {
  const config = getTranslatorConfig();
  if (!config || !TRANSLATE_TO || !text) return null;

  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'Translate the user text into concise, natural Simplified Chinese. Preserve names, links, model names, and technical terms when appropriate. Return only the translation.',
          },
          {
            role: 'user',
            content: `${context}\n\n${text}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error(`  WARN: translation failed: ${err.message}`);
    return null;
  }
}

async function translateParagraphs(paragraphs) {
  const config = getTranslatorConfig();
  if (!config || !TRANSLATE_TO) {
    return paragraphs.map((original) => ({ original, translated: null }));
  }

  const pairs = [];
  for (const original of paragraphs.slice(0, BILINGUAL_PARAGRAPH_LIMIT)) {
    const translated = await translateText(original.slice(0, 1800), 'Article paragraph');
    pairs.push({ original, translated });
  }

  return pairs;
}

function buildChildren({ feedTitle, bilingualPairs }) {
  if (!SYNC_CONTENT) return undefined;

  const children = [calloutBlock(`来源：${feedTitle}`, '📰')];

  if (bilingualPairs?.length) {
    children.push(headingBlock('中英对照'));
    for (const pair of bilingualPairs) {
      if (pair.translated) {
        children.push(paragraphBlock(pair.translated));
      }
      children.push(paragraphBlock(`EN: ${pair.original}`));
      children.push(dividerBlock());
    }
  }

  return children.slice(0, 95);
}

async function fetchFeed(feedUrl) {
  const errors = [];

  for (const url of candidateFeedUrls(feedUrl)) {
    try {
      const res = await fetch(url, {
        headers: FETCH_HEADERS,
        redirect: 'follow',
      });

      if (!res.ok) {
        errors.push(`${url} -> HTTP ${res.status}`);
        continue;
      }

      const xml = await res.text();
      const feed = await parser.parseString(xml);
      if (url !== feedUrl) {
        console.log(`  used mirror: ${url}`);
      }
      return feed;
    } catch (err) {
      errors.push(`${url} -> ${err.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

async function getEnabledFeeds() {
  const res = await notion.databases.query({
    database_id: normalizeId(FEEDS_DB),
    filter: {
      property: 'Enabled',
      checkbox: { equals: true },
    },
  });

  return res.results.map((row) => ({
    title: row.properties.Title.title[0].plain_text,
    feedUrl: row.properties.Link.url,
  }));
}

async function findReaderPageByLink(url) {
  const res = await notion.databases.query({
    database_id: normalizeId(READER_DB),
    filter: {
      property: 'Link',
      url: { equals: url },
    },
    page_size: 1,
  });
  return res.results[0] || null;
}

function blockPlainText(block) {
  const value = block[block.type];
  return (value?.rich_text || [])
    .map((part) => part.plain_text || part.text?.content || '')
    .join('');
}

async function pageHasSyncedContent(pageId) {
  const res = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 20,
  });
  return res.results.some((block) => {
    const text = blockPlainText(block);
    return text.includes('中英对照') || text.startsWith('EN: ');
  });
}

async function appendChildren(pageId, children) {
  for (let i = 0; i < children.length; i += 100) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: children.slice(i, i + 100),
    });
  }
}

async function createReaderItem(item, feedTitle) {
  const title = (item.title || '').trim() || 'Untitled';
  const link = item.link || item.guid;
  if (!link) return 'skip-no-link';

  const existingPage = await findReaderPageByLink(link);
  if (existingPage && !UPDATE_EXISTING) return 'skip-duplicate';
  if (existingPage && (await pageHasSyncedContent(existingPage.id))) {
    return 'skip-existing-with-content';
  }

  const originalText = await getOriginalText(item, link);
  const translatedTitle = await translateText(title, 'Article title');
  const pageTitle = translatedTitle || title;
  const originalParagraphs = splitIntoParagraphs(originalText, 1800, 35).filter(
    (paragraph) => paragraph.length > 40
  );
  const bilingualPairs = await translateParagraphs(
    originalParagraphs.join('\n\n').slice(0, TRANSLATE_CHAR_LIMIT).split(/\n{2,}/)
  );
  const children = buildChildren({
    feedTitle,
    bilingualPairs,
  });

  if (existingPage) {
    if (!children || children.length === 0) return 'skip-no-content';

    if (translatedTitle) {
      await notion.pages.update({
        page_id: existingPage.id,
        properties: {
          Title: {
            title: [{ text: { content: pageTitle.slice(0, 2000) } }],
          },
        },
      });
    }

    await appendChildren(existingPage.id, children);
    console.log(`updated: [${feedTitle}] ${pageTitle}`);
    return 'updated';
  }

  await notion.pages.create({
    parent: { database_id: normalizeId(READER_DB) },
    properties: {
      Title: {
        title: [{ text: { content: pageTitle.slice(0, 2000) } }],
      },
      Link: { url: link },
    },
    ...(children ? { children } : {}),
  });
  console.log(`created: [${feedTitle}] ${pageTitle}`);
  return 'created';
}

function filterRecentItems(items) {
  const now = Date.now() / 1000;
  return items.filter((item) => {
    const t = new Date(item.pubDate || item.isoDate || 0).getTime() / 1000;
    if (!t) return true;
    return now - t < RUN_FREQUENCY;
  });
}

async function fetchRecentItems(feedUrl) {
  const rss = await fetchFeed(feedUrl);
  return filterRecentItems(rss.items || []);
}

async function main() {
  if (!process.env.NOTION_API_TOKEN) throw new Error('Missing NOTION_API_TOKEN');
  if (!FEEDS_DB) throw new Error('Missing NOTION_FEEDS_DATABASE_ID');
  if (!READER_DB) throw new Error('Missing NOTION_READER_DATABASE_ID');

  const me = await notion.users.me();
  console.log(`integration: ${me.name}`);
  console.log(`RUN_FREQUENCY: ${RUN_FREQUENCY}s`);
  console.log(`SYNC_CONTENT: ${SYNC_CONTENT}`);
  console.log(`UPDATE_EXISTING: ${UPDATE_EXISTING}`);
  console.log(`TRANSLATE_TO: ${TRANSLATE_TO || 'disabled'}`);
  if (TRANSLATE_TO && !getTranslatorConfig()) {
    console.log('translation: disabled (missing OPENAI_API_KEY or DEEPSEEK_API_KEY)');
  }

  const feeds = await getEnabledFeeds();
  console.log(`enabled feeds: ${feeds.length}`);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let feedErrors = 0;

  for (const feed of feeds) {
    console.log(`fetch: ${feed.title} -> ${feed.feedUrl}`);
    try {
      const items = await fetchRecentItems(feed.feedUrl);
      console.log(`  recent items: ${items.length}`);

      for (const item of items) {
        const result = await createReaderItem(item, feed.title);
        if (result === 'created') created += 1;
        else if (result === 'updated') updated += 1;
        else skipped += 1;
      }
    } catch (err) {
      feedErrors += 1;
      console.error(`  WARN: feed failed, skip: ${err.message}`);
    }
  }

  console.log(
    `done. created=${created}, updated=${updated}, skipped=${skipped}, feedErrors=${feedErrors}`
  );

  if (feedErrors === feeds.length && feeds.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
