using System.Text;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Presentation;
using UglyToad.PdfPig;

namespace MediTest.Services;

public interface ITextExtractionService
{
    Task<string> ExtractTextAsync(IFormFile file, CancellationToken cancellationToken);
}

public sealed partial class TextExtractionService : ITextExtractionService
{
    public async Task<string> ExtractTextAsync(IFormFile file, CancellationToken cancellationToken)
    {
        var extension = Path.GetExtension(file.FileName).ToLowerInvariant();
        await using var stream = file.OpenReadStream();

        return extension switch
        {
            ".pdf" => ExtractPdf(stream),
            ".pptx" => ExtractPptx(stream),
            ".txt" => await ExtractTxtAsync(stream, cancellationToken),
            _ => throw new InvalidOperationException("Nur PDF, PPTX und TXT sind erlaubt.")
        };
    }

    private static string ExtractPdf(Stream stream)
    {
        var sb = new StringBuilder();
        using var document = PdfDocument.Open(stream);
        foreach (var page in document.GetPages())
        {
            var words = page.GetWords()
                .OrderByDescending(w => Math.Round(w.BoundingBox.Bottom / 3) * 3)
                .ThenBy(w => w.BoundingBox.Left)
                .ToList();

            if (words.Count == 0)
            {
                sb.AppendLine(page.Text);
                sb.AppendLine();
                continue;
            }

            double? currentLine = null;
            foreach (var word in words)
            {
                var line = Math.Round(word.BoundingBox.Bottom / 3) * 3;
                if (currentLine is null || Math.Abs(line - currentLine.Value) > 1)
                {
                    if (currentLine is not null) sb.AppendLine();
                    currentLine = line;
                }
                else
                {
                    sb.Append(' ');
                }
                sb.Append(word.Text);
            }
            sb.AppendLine();
            sb.AppendLine();
        }
        return Normalize(sb.ToString());
    }

    private static string ExtractPptx(Stream stream)
    {
        using var presentation = PresentationDocument.Open(stream, false);
        var sb = new StringBuilder();
        var part = presentation.PresentationPart;
        if (part?.Presentation?.SlideIdList == null) return string.Empty;

        foreach (var slideId in part.Presentation.SlideIdList.Elements<SlideId>())
        {
            var relationshipId = slideId.RelationshipId?.Value;
            if (string.IsNullOrWhiteSpace(relationshipId)) continue;
            var rel = part.GetPartById(relationshipId);
            if (rel is not SlidePart slidePart) continue;
            foreach (var text in slidePart.Slide.Descendants<DocumentFormat.OpenXml.Drawing.Text>())
                sb.AppendLine(text.Text);
            sb.AppendLine();
        }
        return Normalize(sb.ToString());
    }

    private static async Task<string> ExtractTxtAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms, cancellationToken);
        var bytes = ms.ToArray();

        try
        {
            var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
            return Normalize(utf8.GetString(bytes));
        }
        catch (DecoderFallbackException)
        {
            // Viele deutsche TXT-Dateien aus Windows sind nicht UTF-8, sondern ANSI/Latin-1.
            return Normalize(Encoding.Latin1.GetString(bytes));
        }
    }

    private static string Normalize(string text)
    {
        text = RepairCommonMojibake(text);
        var lines = text.Replace("\r", "").Split('\n')
            .Select(l => RegexWhitespace().Replace(l.Trim(), " "))
            .Where(l => !string.IsNullOrWhiteSpace(l));
        return string.Join(Environment.NewLine, lines);
    }

    private static string RepairCommonMojibake(string text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        return text
            .Replace("\u00c3\u00a4", "ä").Replace("\u00c3\u00b6", "ö").Replace("\u00c3\u00bc", "ü")
            .Replace("\u00c3\u0084", "Ä").Replace("\u00c3\u0096", "Ö").Replace("\u00c3\u009c", "Ü")
            .Replace("\u00c3\u009f", "ß").Replace("\u00c2\u00b7", "·").Replace("\u00c2", "")
            .Replace("\u00e2\u20ac\u201c", "–").Replace("\u00e2\u20ac\u201d", "—").Replace("\u00e2\u20ac\u017e", "„")
            .Replace("\u00e2\u20ac\u0153", "“").Replace("\u00e2\u20ac\u009d", "”").Replace("\u00e2\u20ac\u02dc", "‘")
            .Replace("\u00e2\u20ac\u2122", "’").Replace("\u00e2\u20ac\u00a6", "…");
    }

    [System.Text.RegularExpressions.GeneratedRegex("\\s+")]
    private static partial System.Text.RegularExpressions.Regex RegexWhitespace();
}
