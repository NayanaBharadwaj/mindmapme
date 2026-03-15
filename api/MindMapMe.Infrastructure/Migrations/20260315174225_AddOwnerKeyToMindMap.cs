using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace MindMapMe.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddOwnerKeyToMindMap : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "OwnerKey",
                table: "MindMaps",
                type: "text",
                nullable: false,
                defaultValue: "");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "OwnerKey",
                table: "MindMaps");
        }
    }
}
