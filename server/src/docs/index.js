const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const specPath = path.join(__dirname, 'openapi.yaml');
const spec = yaml.load(fs.readFileSync(specPath, 'utf-8'));

module.exports = spec;
