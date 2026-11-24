"""Word mail-merge letter for the check-in codes (called by checkin-codes.js).

    python3 checkin-codes-docx.py <out.docx> <site> <owner> <from mailbox>

The merge fields match the columns of "Check-in codes - mail merge data.xlsx":
FirstName, Code, SignIn. In Word: Mailings > Select Recipients > Use an
Existing List (the .xlsx), then Finish & Merge > Send Email Messages.
"""
import sys
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

out, site, owner, sender = sys.argv[1:5]


def field(par, name, bold=False):
    """Insert a Word MERGEFIELD showing «name» until merged."""
    def run_with(el):
        r = OxmlElement("w:r")
        if bold:
            rpr = OxmlElement("w:rPr")
            rpr.append(OxmlElement("w:b"))
            r.append(rpr)
        r.append(el)
        par._p.append(r)
    b = OxmlElement("w:fldChar"); b.set(qn("w:fldCharType"), "begin"); run_with(b)
    t = OxmlElement("w:instrText"); t.set(qn("xml:space"), "preserve"); t.text = f" MERGEFIELD {name} "; run_with(t)
    s = OxmlElement("w:fldChar"); s.set(qn("w:fldCharType"), "separate"); run_with(s)
    v = OxmlElement("w:t"); v.text = f"«{name}»"; run_with(v)
    e = OxmlElement("w:fldChar"); e.set(qn("w:fldCharType"), "end"); run_with(e)


doc = Document()
st = doc.styles["Normal"]
st.font.name = "Calibri"
st.font.size = Pt(11)

p = doc.add_paragraph("Hi "); field(p, "FirstName"); p.add_run(",")
doc.add_paragraph("You're invited to the AI adoption check-in. It takes about 12 minutes.")
p = doc.add_paragraph("Your personal check-in code is: ")
field(p, "Code", bold=True)
for run in p.runs:
    run.font.size = Pt(13)
doc.add_paragraph("1. Open " + site)
p = doc.add_paragraph("2. "); field(p, "SignIn")
doc.add_paragraph("3. Check your details and answer the questions.")
doc.add_paragraph("Please keep this code to yourself: it makes sure only you can take the check-in as you. "
                  "If you lose it, message the " + owner + " on Microsoft Teams for a new one.")
doc.add_paragraph("Thank you,\n" + owner + "\n" + sender)
note = doc.add_paragraph()
r = note.add_run("Set the subject in Word when sending (Finish & Merge > Send Email Messages): "
                 "\"Your code for the AI adoption check-in\". Delete this line before merging.")
r.italic = True
r.font.size = Pt(9)
r.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
doc.save(out)
