/**
 * Notion Feeder lite: sync RSS title + link only (no HTML body blocks).
 *
 * Env: NOTION_API_TOKEN, NOTION_FEEDS_DATABASE_ID, NOTION_READER_DATABASE_ID
 * Optional: RUN_FREQUENCY (seconds, default 604800 = 7 days)
 */

const { Client } = require('@notionhq/client');
const Parser = require('rss-parser');

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

async function readerHasLink(url) {
  const res = await notion.databases.query({
    database_id: normalizeId(READER_DB),
    filter: {
      property: 'Link',
      url: { equals: url },
    },
    page_size: 1,
  });
  return res.results.length > 0;
}

async function createReaderItem(item, feedTitle) {
  const title = (item.title || '').trim() || 'Untitled';
  const link = item.link || item.guid;
  if (!link) return 'skip-no-link';

  if (await readerHasLink(link)) return 'skip-duplicate';

  await notion.pages.create({
    parent: { database_id: normalizeId(READER_DB) },
    properties: {
      Title: {
        title: [{ text: { content: title.slice(0, 2000) } }],
      },
      Link: { url: link },
    },
  });
  console.log(`created: [${feedTitle}] ${title}`);
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

  const feeds = await getEnabledFeeds();
  console.log(`enabled feeds: ${feeds.length}`);

  let created = 0;
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
        else skipped += 1;
      }
    } catch (err) {
      feedErrors += 1;
      console.error(`  WARN: feed failed, skip: ${err.message}`);
    }
  }

  console.log(`done. created=${created}, skipped=${skipped}, feedErrors=${feedErrors}`);

  if (feedErrors === feeds.length && feeds.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
