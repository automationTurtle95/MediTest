namespace MediTest.Models;

public sealed class Question
{
    public int Id { get; set; }
    public int UploadedDocumentId { get; set; }
    public UploadedDocument? Document { get; set; }
    public string QuestionText { get; set; } = string.Empty;
    public int CorrectOptionIndex { get; set; }
    public string Explanation { get; set; } = string.Empty;
    public string Topic { get; set; } = string.Empty;
    public string Difficulty { get; set; } = "mittel";
    public bool IsAiGenerated { get; set; }
    public string ImageDataUrl { get; set; } = string.Empty;
    public string ImageAltText { get; set; } = string.Empty;
    public string ImageFileName { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public List<AnswerOption> Options { get; set; } = new();
}
