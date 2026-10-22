#!/bin/sh
set -eu

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

for command in ffmpeg ffprobe pdfinfo pdftoppm pdftotext yt-dlp; do
    command -v "$command" >/dev/null
done
printf '%s\n' 'Hermes Python runtime:'
/opt/hermes/.venv/bin/python - <<'PY'
import sys
print(sys.executable)
print(sys.path)
PY
find /opt/hermes/.venv -maxdepth 4 -type d -name 'openpyxl*' -print
/opt/hermes/.venv/bin/python - <<'PY'
import jsonschema
import openpyxl
import PIL
import pypdfium2
import xlrd
import msoffcrypto
PY

python3 - "$work/sample.pdf" <<'PY'
import sys

path = sys.argv[1]
content = b"BT\n/F1 18 Tf\n72 720 Td\n(OpenLia PDF) Tj\nET\n"
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
data = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
offsets = [0]
for number, obj in enumerate(objects, 1):
    offsets.append(len(data))
    data += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
xref = len(data)
data += b"xref\n0 6\n0000000000 65535 f \n"
for offset in offsets[1:]:
    data += f"{offset:010d} 00000 n \n".encode()
data += b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n"
data += str(xref).encode() + b"\n%%EOF\n"
with open(path, "wb") as output:
    output.write(data)
PY
pdftotext "$work/sample.pdf" "$work/sample.txt"
grep -Fqx 'OpenLia PDF' "$work/sample.txt"
printf '%s\n' 'name,value' 'OpenLia,1' >"$work/sample.csv"
python3 - "$work/sample.xlsx" <<'PY'
import sys
from openpyxl import Workbook
book = Workbook()
sheet = book.active
sheet.append(["name", "value"])
sheet.append(["OpenLia", 1])
book.save(sys.argv[1])
PY
test -s "$work/sample.xlsx"

ffmpeg -version >/dev/null
yt-dlp --version >/dev/null
