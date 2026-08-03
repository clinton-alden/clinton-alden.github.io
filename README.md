# clinton-alden.github.io

Modernized personal portfolio with dynamic navigation, reveal animations, and a consistent CV page.

## Quick Start

Preview locally with a static server:

1. Open a terminal and run from the project root:

```bash
python3 -m http.server 8000
```

2. Visit http://localhost:8000 in your browser.

For the Fire Tools page, generate the current HRRR smoke overlays locally, then start the preview server:

```bash
./scripts/preview-site.sh --refresh-smoke
```

After that first run, use `./scripts/preview-site.sh` for normal HTML, CSS, and JavaScript iteration. The generated data stays local and does not need to be committed or pushed.

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
