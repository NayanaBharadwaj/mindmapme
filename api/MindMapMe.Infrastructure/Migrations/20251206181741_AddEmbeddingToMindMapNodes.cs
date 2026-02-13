using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace MindMapMe.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddEmbeddingToMindMapNodes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<float[]>(
                name: "Embedding",
                table: "MindMapNodes",
                type: "real[]",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Embedding",
                table: "MindMapNodes");
        }
    }
}
