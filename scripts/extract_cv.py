#!/usr/bin/env python3
"""
Extracts key info from CV.pdf into assets/data.json for the website.
Heuristics-based parser using pdfminer.six; adjust patterns as needed.
"""
from __future__ import annotations
import json
import re
from pathlib import Path
from typing import List, Dict

try:
    from pdfminer.high_level import extract_text
except Exception as e:
    raise SystemExit(f"pdfminer.six not installed correctly: {e}\nInstall with: pip install pdfminer.six")

ROOT = Path(__file__).resolve().parents[1]
PDF_PATH = ROOT / "CV.pdf"
OUT_PATH = ROOT / "assets" / "data.json"

# Regex helpers
DATE_RANGE = re.compile(r"\b(19|20)\d{2}\b.*?(Present|(19|20)\d{2})", re.IGNORECASE)
MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December"
MONTH_RANGE = re.compile(rf"\b(?:{MONTHS})\s+(19|20)\d{{2}}\b.*?(Present|(?:{MONTHS})\s+(19|20)\d{{2}})", re.IGNORECASE)
DEGREE_WORDS = [
    "Bachelor", "Bachelors", "B.S", "BS", "BSc", "Master", "MSc", "M.S", "MS",
    "PhD", "Doctor", "Associate"
]
DEGREE_RE = re.compile(r"(" + "|".join([re.escape(w) for w in DEGREE_WORDS]) + r")", re.IGNORECASE)

HEADINGS = [
    "Experience", "Work Experience", "Professional Experience", "Research Experience",
    "Employment", "Positions", "Professional Positions",
    "Education", "Academic", "Qualifications",
    "Summary", "Profile", "About"
]

HEADING_RE = re.compile(r"^\s*(?:" + "|".join([re.escape(h) for h in HEADINGS]) + r")\s*$", re.IGNORECASE)


def normalize_text(text: str) -> List[str]:
    # Normalize dashes and whitespace, split to lines
    text = text.replace("\u2013", "-").replace("\u2014", "-")
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in text.splitlines()]
    # Remove empty duplicates but keep blank separation markers
    return [ln for ln in lines if ln]


def find_section_indices(lines: List[str]) -> Dict[str, int]:
    idx = {}
    for i, ln in enumerate(lines):
        if HEADING_RE.match(ln):
            key = ln.lower()
            # Map variations to canonical keys
            if "experience" in key:
                idx.setdefault("experience", i)
            elif "education" in key or "academic" in key or "qualifications" in key:
                idx.setdefault("education", i)
            elif "summary" in key or "profile" in key or "about" in key:
                idx.setdefault("summary", i)
    return idx

def extract_contact(lines: List[str]) -> Dict[str, str]:
    contact = {"email": "", "phone": "", "location": ""}
    text = " \n".join(lines[:50])  # top lines likely contain contact info
    m_email = re.search(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", text)
    if m_email:
        contact["email"] = m_email.group(0)
    m_phone = re.search(r"\b\+?\d[\d\s\-()]{6,}\b", text)
    if m_phone:
        phone = re.sub(r"\s+", " ", m_phone.group(0)).strip()
        contact["phone"] = phone
    # simple location heuristic: 'City, State' pattern
    m_loc = re.search(r"\b([A-Z][a-zA-Z]+),\s*([A-Z][a-zA-Z]+)\b", text)
    if m_loc:
        contact["location"] = f"{m_loc.group(1)}, {m_loc.group(2)}"
    return contact


def extract_summary(lines: List[str], sections: Dict[str, int]) -> str | None:
    # Prefer explicit summary section; otherwise take top paragraph before Experience
    if "summary" in sections:
        start = sections["summary"] + 1
        end = min([sections.get("experience", len(lines)), sections.get("education", len(lines))])
        para = []
        for ln in lines[start:end]:
            if HEADING_RE.match(ln):
                break
            para.append(ln)
        summary = " ".join(para[:6]) if para else None
        return clean_summary(summary)
    # Fallback: first 4-6 lines before first heading
    first_heading = min(sections.values()) if sections else len(lines)
    para = []
    for ln in lines[:first_heading]:
        if HEADING_RE.match(ln):
            break
        para.append(ln)
    summary = " ".join(para[:6]) if para else None
    return clean_summary(summary)

def clean_summary(text: str | None) -> str | None:
    if not text:
        return text
    # Strip contact info tokens commonly present at the top of CVs
    text = re.sub(r"\b(?:Github|LinkedIn)\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\b\+?\d[\d\s\-()]{6,}\b", "", text)  # phone numbers
    text = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "", text)  # emails
    text = re.sub(r"\s{2,}", " ", text).strip()
    return text


def extract_experience(lines: List[str], sections: Dict[str, int]) -> List[Dict[str, str]]:
    items: List[Dict[str, str]] = []
    start = sections.get("experience", None)
    if start is None:
        # scan whole doc for date ranges
        scan_range = range(0, len(lines))
    else:
        # until next heading
        next_indices = [v for k, v in sections.items() if k != "experience"] or [len(lines)]
        end = min(next_indices) if next_indices else len(lines)
        scan_range = range(start + 1, end)

    i = scan_range.start
    while i < scan_range.stop:
        ln = lines[i]
        if DATE_RANGE.search(ln) or MONTH_RANGE.search(ln):
            period = ln
            title = ""
            company = ""
            desc_lines: List[str] = []
            # title/company likely in next 1-2 lines
            j = i + 1
            if j < scan_range.stop:
                title = lines[j]
                j += 1
            if j < scan_range.stop and not DATE_RANGE.search(lines[j]) and not HEADING_RE.match(lines[j]):
                # sometimes title & company split across lines
                company = lines[j]
                j += 1
            # capture description until next date or heading
            while j < scan_range.stop and not DATE_RANGE.search(lines[j]) and not MONTH_RANGE.search(lines[j]) and not HEADING_RE.match(lines[j]):
                desc_lines.append(lines[j])
                j += 1
            items.append({
                "period": period,
                "title": title,
                "company": company,
                "description": " ".join(desc_lines)
            })
            i = j
        else:
            i += 1
    return items


def extract_education(lines: List[str], sections: Dict[str, int]) -> List[Dict[str, str]]:
    items: List[Dict[str, str]] = []
    start = sections.get("education", None)
    if start is None:
        # scan for degree-like lines globally
        scan_range = range(0, len(lines))
    else:
        next_indices = [v for k, v in sections.items() if k != "education"] or [len(lines)]
        end = min(next_indices) if next_indices else len(lines)
        scan_range = range(start + 1, end)

    i = scan_range.start
    while i < scan_range.stop:
        ln = lines[i]
        if DEGREE_RE.search(ln):
            degree_line = ln
            institution = ""
            field = ""
            j = i + 1
            # The institution or field often appears in next lines
            if j < scan_range.stop and not HEADING_RE.match(lines[j]):
                institution = lines[j]
                j += 1
            if j < scan_range.stop and not HEADING_RE.match(lines[j]) and not DATE_RANGE.search(lines[j]):
                field = lines[j]
                j += 1
            items.append({
                "degree": degree_line,
                "field": field,
                "institution": institution,
            })
            i = j
        else:
            i += 1
    return items


def main() -> None:
    if not PDF_PATH.exists():
        raise SystemExit(f"CV PDF not found at: {PDF_PATH}")
    text = extract_text(str(PDF_PATH))
    lines = normalize_text(text)
    sections = find_section_indices(lines)

    summary = extract_summary(lines, sections) or ""
    experience = extract_experience(lines, sections)
    education = extract_education(lines, sections)
    contact = extract_contact(lines)

    data = {
        "summary": summary,
        "experience": experience,
        "education": education,
        "contact": contact,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"Wrote {OUT_PATH} with {len(experience)} experience items and {len(education)} education entries.")


if __name__ == "__main__":
    main()
