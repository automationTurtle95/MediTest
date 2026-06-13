using MediTest.Services;
using Xunit;

namespace MediTest.Tests;

public sealed class DocumentContentPolicyTests
{
    [Theory]
    [InlineData("application/pdf")]
    [InlineData("application/vnd.openxmlformats-officedocument.presentationml.presentation")]
    [InlineData("text/plain")]
    public void EmptyUploadedFilesRemainDocuments(string contentType)
    {
        Assert.Equal(DocumentContentPolicy.DocumentItemType, DocumentContentPolicy.ItemType(contentType, 0));
        Assert.True(DocumentContentPolicy.CanGenerateQuestions(contentType, 0));
    }

    [Theory]
    [InlineData("application/pdf", 5)]
    [InlineData("manual/question-pool", 0)]
    [InlineData("text/imported-question-pool", 0)]
    [InlineData("firestore/catalog-test", 0)]
    public void QuestionPoolsAndFilesWithQuestionsAreTests(string contentType, int questionCount)
    {
        Assert.Equal(DocumentContentPolicy.TestItemType, DocumentContentPolicy.ItemType(contentType, questionCount));
        Assert.False(DocumentContentPolicy.CanGenerateQuestions(contentType, questionCount));
    }

    [Fact]
    public void StoredFileSizeWinsOverLegacyFallback()
    {
        Assert.Equal(4096, DocumentContentPolicy.DisplaySizeBytes(4096, 123));
        Assert.Equal(123, DocumentContentPolicy.DisplaySizeBytes(0, 123));
    }
}
