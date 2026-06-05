namespace MediTest.Models;

public sealed class TestAnswer
{
    public int Id { get; set; }
    public int TestSessionId { get; set; }
    public TestSession? TestSession { get; set; }
    public int QuestionId { get; set; }
    public Question? Question { get; set; }
    public int DisplayOrder { get; set; }
    public string ShuffledOptionIdsJson { get; set; } = "[]";
    public int? SelectedAnswerOptionId { get; set; }
    public bool IsCorrect { get; set; }
}
