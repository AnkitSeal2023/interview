"""Create a text-PDF fixture for tests/demo (uses dev dep fpdf2)."""
import sys


def make_pdf(path: str, lines: list[str]) -> None:
    from fpdf import FPDF

    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", size=11)
    for ln in lines:
        pdf.cell(text=ln, new_x="LMARGIN", new_y="NEXT")
    pdf.output(path)


if __name__ == "__main__":
    make_pdf(sys.argv[1], sys.argv[2:])
