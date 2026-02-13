using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace MindMapMe.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddMindMapNodeTextContent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Content",
                table: "MindMapNodes",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Text",
                table: "MindMapNodes",
                type: "text",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_MindMapNodes_MindMapId",
                table: "MindMapNodes",
                column: "MindMapId");

            migrationBuilder.AddForeignKey(
                name: "FK_MindMapNodes_MindMaps_MindMapId",
                table: "MindMapNodes",
                column: "MindMapId",
                principalTable: "MindMaps",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_MindMapNodes_MindMaps_MindMapId",
                table: "MindMapNodes");

            migrationBuilder.DropIndex(
                name: "IX_MindMapNodes_MindMapId",
                table: "MindMapNodes");

            migrationBuilder.DropColumn(
                name: "Content",
                table: "MindMapNodes");

            migrationBuilder.DropColumn(
                name: "Text",
                table: "MindMapNodes");
        }
    }
}
