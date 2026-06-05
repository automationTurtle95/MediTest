namespace MediTest.Models;

public sealed class TestSession
{
    public int Id { get; set; }
    public int UploadedDocumentId { get; set; }
    public UploadedDocument? Document { get; set; }
    public string TestName { get; set; } = string.Empty;
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? SubmittedAt { get; set; }
    public int QuestionCount { get; set; }
    public int Score { get; set; }
    public double Percent { get; set; }
    public bool Passed { get; set; }
    public List<TestAnswer> Answers { get; set; } = new();
}
