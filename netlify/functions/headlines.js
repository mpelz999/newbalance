// netlify/functions/headlines.js
// Fetches RSS feeds from specific left and right news outlets.
// RSS is free, no API key needed, no rate limits, no domain restrictions.

const LEFT_FEEDS = [
  { label: 'CNN',            url: 'https://rss.cnn.com/rss/cnn_topstories.rss' },
  { label: 'NBC News',       url: 'https://feeds.nbcnews.com/nbcnews/public/news' },
  { label: 'NPR',            url: 'https://feeds.npr.org/1001/rss.xml' },
  { label: 'AP News',        url: 'https://rsshub.app/ap/topics/apf-topnews' },
  { label: 'The Guardian',   url: 'https://www.theguardian.com/us-news/rss' },
  { label: 'Washington Post',url: 'https://feeds.washingtonpost.com/rss/politics' },
  { label: 'Politico',       url: 'https://www.politico.com/rss/politicopicks.xml' },
  { label: 'ABC News',       url: 'https://feeds.abcnews.com/abcnews/topstories' },
];

const RIGHT_FEEDS = [
  { label: 'Fox News',        url: 'https://moxie.foxnews.com/google-publisher/latest.xml' },
  { label: 'Breitbart',       url: 'https://feeds.feedburner.com/breitbart' },
  { label: 'NY Post',         url: 'https://nypost.com/feed/' },
  { label: 'The Hill',        url: 'https://thehill.com/feed/' },
  { label: 'Newsweek',        url: 'https://www.newsweek.com/rss' },
  { label: 'Washington Times',url: 'https://www.washingtontimes.com/rss/headlines/news/' },
  { label: 'National Review', url: 'https://www.nationalreview.com/feed/' },
  { label: 'Daily Wire',      url: 'https://www.dailywire.com/feeds/rss.xml' },
];

exports.handler = async function(event) {
  try {
    const [leftResults, rightResults] = await Promise.all([
      Promise.allSettled(LEFT_FEEDS.map(f => fetchFeed(f))),
      Promise.allSettled(RIGHT_FEEDS.map(f => fetchFeed(f))),
    ]);

    const leftArticles  = leftResults.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
    const rightArticles = rightResults.filter(r => r.status === 'fulfilled').flatMap(r => r.value);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        status: 'ok',
        left:  leftArticles,
        right: rightArticles,
        leftCount:  leftArticles.length,
        rightCount: rightArticles.length,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ status: 'error', message: err.message }),
    };
  }
};

async function fetchFeed(feed) {
  const response = await fetch(feed.url, {
    headers: { 'User-Agent': 'NewsBalance/1.0 (newsbalance.io)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return [];
  const xml = await response.text();
  return parseRSS(xml, feed.label);
}

function parseRSS(xml, sourceName) {
  const articles = [];
  const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];

  for (const item of items.slice(0, 15)) {
    const title       = decodeEntities(extractTag(item, 'title'));
    const description = decodeEntities(stripHTML(extractTag(item, 'description') || extractTag(item, 'summary')));
    const url         = extractTag(item, 'link') || extractAttr(item, 'link', 'href');
    const publishedAt = extractTag(item, 'pubDate') || extractTag(item, 'published') || new Date().toISOString();
    const image       = extractImage(item);

    if (!title || title === '[Removed]' || title.length < 10) continue;
    if (!url) continue;

    articles.push({
      title,
      description: description?.slice(0, 300) || '',
      url,
      urlToImage: image || null,
      publishedAt: new Date(publishedAt).toISOString(),
      source: { name: sourceName },
    });
  }
  return articles;
}

function extractTag(xml, tag) {
  const patterns = [
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'),
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["']`, 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

function extractImage(item) {
  const patterns = [
    /media:content[^>]+url=["']([^"']+)["']/i,
    /media:thumbnail[^>]+url=["']([^"']+)["']/i,
    /enclosure[^>]+url=["']([^"']+\.(jpg|jpeg|png|webp))["']/i,
    /<img[^>]+src=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = item.match(re);
    if (m && m[1] && !m[1].includes('pixel') && !m[1].includes('track')) return m[1];
  }
  return null;
}

function stripHTML(str) {
  return (str || '').replace(/<[^>]+>/g, '').trim();
}

function decodeEntities(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .trim();
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
