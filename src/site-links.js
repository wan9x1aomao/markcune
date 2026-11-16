const REPOSITORY = 'https://github.com/wan9x1aomao/markcune';

/** A build may opt into the independent site once its domain is live. */
export function siteLinks(origin = '') {
  origin = origin.trim();
  if (!origin) return { homepage: REPOSITORY, changelog: `${REPOSITORY}/releases` };
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || /workbuddy/i.test(url.hostname) || !url.hostname.includes('.') || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.invalid') || url.hostname.endsWith('.test') || /^[\d.]+$/.test(url.hostname)) throw new Error('官网地址必须是独立 HTTPS 根地址');
  return { homepage: url.origin, changelog: `${url.origin}/guide.html#changelog` };
}
