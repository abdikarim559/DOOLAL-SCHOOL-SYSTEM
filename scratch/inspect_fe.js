const fs = require('fs');

const html = fs.readFileSync('frontend/index.html', 'utf8');
const lines = html.split('\n');

console.log('--- FINDING VIEWS IN index.html ---');
lines.forEach((line, idx) => {
    if (line.includes('id=') && (line.includes('view') || line.includes('section'))) {
        console.log(`Line ${idx + 1}: ${line.trim()}`);
    }
});

console.log('\n--- FINDING ATTENDANCE SECTION ---');
lines.forEach((line, idx) => {
    if (line.toLowerCase().includes('attendance') && line.includes('<div') || line.includes('<section')) {
        console.log(`Line ${idx + 1}: ${line.trim()}`);
    }
});
