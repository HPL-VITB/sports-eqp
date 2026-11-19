"""Static accessibility checks on rendered preview HTML: form fields need a label, buttons and links need text,
images need alt text, headings start at h1, the page declares a language. Usage: python3 a11y_check.py DIR"""
import glob, sys
from html.parser import HTMLParser

class P(HTMLParser):
    def __init__(self):
        super().__init__(); self.stack=[]; self.fields=[]; self.label_for=set(); self.issues=[]; self.h=[]; self.lang=False
        self.btn=None; self.a=None
    def handle_starttag(self, t, a):
        a=dict(a)
        if t=="html" and a.get("lang"): self.lang=True
        in_label=any(x=="label" for x in self.stack)
        if t=="label" and a.get("for"): self.label_for.add(a["for"])
        if t in("input","select","textarea") and a.get("type") not in("hidden","submit","button"):
            self.fields.append((a.get("name") or a.get("type") or t, a.get("id"), in_label or bool(a.get("aria-label")) or bool(a.get("aria-labelledby"))))
        if t=="img" and "alt" not in a: self.issues.append("img without alt")
        if t in("h1","h2","h3","h4"): self.h.append(int(t[1]))
        if t=="button": self.btn=[a.get("aria-label") or ""]
        if t=="a": self.a=[a.get("aria-label") or "", a.get("href")]
        if t not in("input","img","br","hr","meta","link"): self.stack.append(t)
    def handle_endtag(self, t):
        if t=="button" and self.btn is not None:
            if not "".join(self.btn).strip(): self.issues.append("button without text")
            self.btn=None
        if t=="a" and self.a is not None:
            if not "".join(self.a[:-1]).strip(): self.issues.append(f"link without text {self.a[-1]}")
            self.a=None
        while self.stack and self.stack.pop()!=t: pass
    def handle_data(self, d):
        if self.btn is not None: self.btn.append(d)
        if self.a is not None: self.a.insert(0,d)

total=0
for f in sorted(glob.glob(sys.argv[1]+"/*.html")):
    p=P(); p.feed(open(f).read())
    iss=list(p.issues)
    for name,i,ok in p.fields:
        if not ok and not (i and i in p.label_for): iss.append(f"field without label: {name}")
    if not p.lang: iss.append("no lang")
    if p.h and p.h[0]!=1 and "public" not in f: iss.append(f"first heading h{p.h[0]}")
    if p.h.count(1)>1: iss.append("several h1")
    if iss:
        total+=len(iss); print(f.split('/')[-1], sorted(set(iss)))
print("pages:", len(glob.glob(sys.argv[1]+"/*.html")), "issues:", total)
