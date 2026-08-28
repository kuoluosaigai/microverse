/**
 * adm-zip decodes every zip entry name as UTF-8 (its default decoder is
 * `data.toString("utf8")`), which garbles filenames written by tools that
 * encode names in the local codepage — Windows Explorer and Chinese archivers
 * write GBK bytes without setting the UTF-8 flag. This decoder first tries
 * UTF-8; if the result contains U+FFFD replacement characters the bytes were
 * not valid UTF-8, so it re-decodes them as GB18030 (a superset of GBK).
 *
 * Pass this as adm-zip's `decoder` option when reading zips:
 *   new AdmZip(buf, { decoder: zipDecoder });
 */
const gb18030 = new TextDecoder('gb18030');

module.exports = {
  // encode is only used when adm-zip *writes* a zip (e.g. backups); keep UTF-8.
  encode: (data) => Buffer.from(data, 'utf8'),
  decode: (data) => {
    const utf8 = data.toString('utf8');
    return utf8.includes('�') ? gb18030.decode(data) : utf8;
  },
};
