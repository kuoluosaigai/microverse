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
    return new URL(template.replace('{name}', app.name)).toString()
  } catch (_e) {
    return null
  }
}
