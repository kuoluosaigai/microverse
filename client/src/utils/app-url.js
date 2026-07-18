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
