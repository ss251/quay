# Inlines the icon sprite into each page in src/. Run: python3 -I design/round2/build.py
from pathlib import Path
root = Path(__file__).parent
sprite = (root / "sprite.html").read_text()
for src in sorted((root / "src").glob("*.html")):
    (root / src.name).write_text(src.read_text().replace("<!--SPRITE-->", sprite))
    print("built", src.name)
