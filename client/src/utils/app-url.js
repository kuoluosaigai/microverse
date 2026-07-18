/**
 * Build the "open app" URL from the public template, or null to fall back.
 * The template (e.g. "https://{name}.yourdomain.com") has {name} replaced by
 * the app name; the result is validated with new URL() so a malformed
 * template/name never produces a broken link.
 * @param {{name:string}} app
 * @param {string} template
 * @returns {string|null}
 */
export function buildAppUrl(app, template) {
  if (!template || !template.includes('{name}')) return null
  try {
    const url = new URL(template.replace('{name}', app.name))
    // Only http/https — reject javascript:/data:/etc. even though the template
    // is admin-controlled, so this helper stays safe to reuse.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch (_e) {
    return null
  }
}

/**
 * Build the ROOT-domain URL for the app marked as the reverse-proxy default —
 * so its "open" link goes to e.g. https://yourdomain.com, not its {name}
 * subdomain (which is what the reverse proxy actually serves at the root).
 * Prefers an explicit PROXY_BASE_DOMAIN; otherwise strips the `{name}.` segment
 * from the public template. Validated with new URL(); returns null to fall back.
 * @param {{template?:string, proxyBaseDomain?:string}} opts
 * @returns {string|null}
 */
export function buildRootUrl({ template, proxyBaseDomain } = {}) {
  let raw = null
  if (proxyBaseDomain) {
    const scheme = template && /^https:\/\//i.test(template) ? 'https' : 'http'
    raw = `${scheme}://${proxyBaseDomain}`
  } else if (template && template.includes('{name}')) {
    // https://{name}.yourdomain.com -> https://yourdomain.com
    raw = template.replace(/\{name\}\.?/, '')
  }
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch (_e) {
    return null
  }
}
