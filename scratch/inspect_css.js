const fs = require('fs');
const css = fs.readFileSync('frontend/css/style.css', 'utf8');
const lines = css.split('\n');

lines.forEach((line, idx) => {
    if (line.includes('.badge') || line.includes('.att-btn') || line.includes('.badge-warning')) {
        console.log(`Line ${idx + 1}: ${line}`);
    }
});
