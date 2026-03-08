// netlify/functions/headlines.js
// Fetches RSS feeds from specific left and right news outlets.
// RSS is free, no API key needed, no rate limits, no domain restrictions.
//
// SOURCE SELECTION PHILOSOPHY:
//   Left side:  Center-left to left-leaning outlets with broad topic coverage
//   Right side: Center-right to right-leaning outlets with broad topic coverage
//   Both sides intentionally include sources that cover diverse topics
//   (sports, tech, science, crime, economy) — not just politics —
//   so the pairing algorithm has enough material to show 10+ comparisons daily.
//
// REMOVED: Breitbart, Daily Wire — publish almost exclusively politics/culture war,
//   which starves the algorithm of non-political pairable content.
// ADDED:   Washington Examiner, Reason — conservative/libertarian with broader topics.
//          Reuters — wire service for topic diversity on right side.
//          CBS News, USA Today — added to left for more topic breadth.

const LEFT_FEEDS = [
  { label: 'CNN',             url: 'https://rss.cnn.com/rss/cnn_topstories.rss' },
  { label: 'NBC News',        url: 'https://feeds.nbcnews.com/nbcnews/public/news' },
  { label: 'NPR',             url: 'https://feeds.npr.org/1001/rss.xml' },
  { label: 'ABC News',        url: 'https://feeds.abcnews.com/abcnews/topstories' },
  { label: 'Washington Post', url: 'https://feeds.washingtonpost.com/rss/politics' },
  { label: 'The Guardian',    url: 'https://www.theguardian.com/us-news/rss' },
  { label: 'AP News',         url: 'https://rsshub.app/ap/topics/apf-topnews' },
  { label: 'Politico',        url: 'https://www.politico.com/rss/politicopicks.xml' },
  { label: 'CBS News',        url: 'https://www.cbsnews.com/latest/rss/main' },
  { label: 'USA Today',       url: 'https://rssfeeds.usatoday.com/usatoday-NewsTopStories' },
];

const RIGHT_FEEDS = [
  { label: 'Fox News',         url: 'https://moxie.foxnews.com/google-publisher/latest.xml' },
  { label: 'NY Post',          url: 'https://nypost.com/feed/' },
  { label: 'National Review',  url: 'https://www.nationalreview.com/feed/' },
  { label: 'Washington Times', url: 'https://www.washingtontimes.com/rss/headlines/news/' },
  { label: 'Wash. Examiner',   url: 'https://www.washingtonexaminer.com/feed' },
  { label: 'The Hill',         url: 'https://thehill.com/feed/' },
  { label: 'Newsweek',         url: 'https://www.newsweek.com/rss' },
  { label: 'Reason',           url: 'https://reason.com/feed/' },
  { label: 'Reuters',          url: 'https://feeds.reuters.com/reuters/topNews' },
  { label: 'Daily Mail',       url: 'https://www.dailymail.co.uk/articles.rss' },
];

// Maximum number of articles per feed to attempt OG image fallback on.
// Keeps total function runtime under Netlify's 10s limit.
// Only articles missing an RSS image are fetched.
const MAX_OG_FETCHES_PER_FEED = 8;
const OG_FETCH_TIMEOUT_MS = 3000;

exports.handler = async function(event) {
  try {
    const [leftResults, rightResults] = await Promise.all([
      Promise.allSettled(LEFT_FEEDS.map(f => fetchFeed(f))),
      Promise.allSettled(RIGHT_FEEDS.map(f => fetchFeed(f))),
    ]);

    const leftArticles  = leftResults.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
    const rightArticles = rightResults.filter(r => r.status === 'fulfilled').flatMap(r => r.value);

    // OG image fallback: for articles missing images, fetch the article page
    // and scrape og:image. Cap fetches per side to stay within time budget.
    await Promise.all([
      fillMissingImages(leftArticles),
      fillMissingImages(rightArticles),
    ]);

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

// ─── OG IMAGE FALLBACK ────────────────────────────────────────────────────────
// For each article missing an image, fetch the article HTML and scrape og:image.
// Fetches are run in parallel, capped at MAX_OG_FETCHES_PER_FEED total.
async function fillMissingImages(articles) {
  const missing = articles
    .filter(a => !a.urlToImage && a.url && a.url.startsWith('http'))
    .slice(0, MAX_OG_FETCHES_PER_FEED);

  await Promise.allSettled(
    missing.map(async (article) => {
      try {
        const res = await fetch(article.url, {
          headers: {
            'User-Agent': 'NewsBalance/1.0 (newsbalance.io)',
            'Accept': 'text/html',
          },
          signal: AbortSignal.timeout(OG_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return;

        // Only read first 8KB — og:image is always in <head>, no need for full body
        const reader = res.body.getReader();
        let html = '';
        while (html.length < 8000) {
          const { done, value } = await reader.read();
          if (done) break;
          html += new TextDecoder().decode(value);
        }
        reader.cancel();

        const img = extractOgImage(html);
        if (img) article.urlToImage = img;
      } catch (_) {
        // Silently skip — article will show placeholder
      }
    })
  );
}

function extractOgImage(html) {
  const patterns = [
    // Standard og:image
    /property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
    // Twitter card image
    /name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i,
    // Generic large image meta
    /property=["']og:image:secure_url["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] && m[1].startsWith('http') && !m[1].includes('pixel') && !m[1].includes('track')) {
      return m[1];
    }
  }
  return null;
}

// ─── RSS PARSING ──────────────────────────────────────────────────────────────
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
  const items = xml.match(/<item[\s\S]*?<\/item>/g) ||
                xml.match(/<entry[\s\S]*?<\/entry>/g) || [];

  for (const item of items.slice(0, 20)) {
    const title       = decodeEntities(extractTag(item, 'title'));
    const description = decodeEntities(stripHTML(
      extractTag(item, 'description') ||
      extractTag(item, 'summary')     ||
      extractTag(item, 'content')
    ));
    const url         = extractTag(item, 'link') || extractAttr(item, 'link', 'href');
    const publishedAt = extractTag(item, 'pubDate')  ||
                        extractTag(item, 'published') ||
                        extractTag(item, 'updated')   ||
                        new Date().toISOString();
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
  // Priority order: dedicated thumbnail tags first, then content tags, then fallbacks.
  // media:content can be video (.m3u8, .mp4) — always check for a thumbnail sibling first.
  const patterns = [
    // Dedicated thumbnail tags — always images, never video
    /media:thumbnail[^>]+url=["']([^"']+)["']/i,
    // media:content but only if it's explicitly typed as an image
    /media:content[^>]+type=["']image\/[^"']+["'][^>]*url=["']([^"']+)["']/i,
    /media:content[^>]+url=["']([^"']+\.(jpg|jpeg|png|webp))["']/i,
    // Enclosure image
    /enclosure[^>]+url=["']([^"']+\.(jpg|jpeg|png|webp))["']/i,
    // og:image embedded in item
    /property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
    // itunes:image
    /itunes:image[^>]+href=["']([^"']+)["']/i,
    // First <img> in description HTML
    /<img[^>]+src=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = item.match(re);
    if (m && m[1]
      && m[1].startsWith('http')
      && !m[1].includes('pixel')
      && !m[1].includes('track')
      && !m[1].includes('.m3u8')   // skip video playlists
      && !m[1].includes('.mp4')    // skip video files
      && !m[1].includes('.webm')
    ) {
      return m[1];
    }
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
