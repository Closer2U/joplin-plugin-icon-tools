const fs = require('fs');
const path = require('path');
const tar = require('tar');

(async () => {
  const root = path.resolve(__dirname, '..');
  const distDir = path.join(root, 'dist');
  const publishDir = path.join(root, 'publish');
  const manifestPath = path.join(distDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error('Missing dist/manifest.json. Run npm run build first.');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.mkdirSync(publishDir, { recursive: true });

  const baseName = `${manifest.id}-${manifest.version}`;
  const jplPath = path.join(publishDir, `${baseName}.jpl`);
  const jsonPath = path.join(publishDir, `${baseName}.json`);

  const files = fs.readdirSync(distDir);

  // Joplin's .jpl package format is the contents of the dist folder in a TAR
  // archive, not a ZIP file. The manifest.json must be at the archive root.
  await tar.c(
    {
      cwd: distDir,
      file: jplPath,
      portable: true,
      noMtime: true,
    },
    files
  );

  fs.writeFileSync(jsonPath, JSON.stringify(manifest, null, 2));
  console.log(`Created ${jplPath}`);
})();
