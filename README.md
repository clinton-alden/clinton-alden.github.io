# clinton-alden.github.io

Modernized personal portfolio with dynamic navigation, reveal animations, and a consistent CV page.

## Quick Start

Preview locally with a static server:

1. Open a terminal and run from the project root:

```bash
python3 -m http.server 8000
```

2. Visit http://localhost:8000 in your browser.

## Structure

- index.html — Main portfolio (About, Experience, Projects, Skills, Contact)
- cv.html — Styled CV snapshot
- assets/styles.css — Theme, layout, responsive styles
- assets/script.js — Navigation, smooth scroll, scrollspy, reveal animations

## Customize

- Update content in index.html and cv.html.
- Tweak theme colors in assets/styles.css (`:root` CSS variables).
- Replace or rename the PDF at the project root to `CV.pdf` and it will be linked automatically.
- To tailor site content to match your CV, edit `assets/data.json` and refresh; summary, experience, and education will update dynamically.