const fs = require('fs');
const path = require('path');

const UPLOAD_URL = process.env.UPLOAD_URL || 'http://localhost:8787/api/upload';
const TOKEN = process.env.TOKEN;

async function main() {
  if (!TOKEN) {
    console.error('TOKEN env var required. Usage: TOKEN=xxx node test-upload.js [path/to/image]');
    process.exit(1);
  }

  const imagePath = process.argv[2] || path.join(__dirname, 'upic.png');
  if (!fs.existsSync(imagePath)) {
    console.error(`File not found: ${imagePath}`);
    process.exit(1);
  }

  console.log(`Uploading ${imagePath} to ${UPLOAD_URL}`);
  const file = fs.readFileSync(imagePath).toString('base64');

  const response = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ file, fileName: path.basename(imagePath) }),
  });

  const text = await response.text();
  if (!response.ok) {
    console.error(`Upload failed (${response.status}): ${text}`);
    process.exit(1);
  }
  console.log('Success:', text);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
