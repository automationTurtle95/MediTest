namespace MediTest.Models;

public sealed class AnswerOption
{
    public int Id { get; set; }
    public int QuestionId { get; set; }
    public Question? Question { get; set; }
    public string Text { get; set; } = string.Empty;
    public int OptionIndex { get; set; }
}
