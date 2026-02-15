# ---- build ----
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY . .
# If your .csproj path is different, adjust this line to the correct one:
RUN dotnet restore MindMapMe.Api/MindMapMe.Api.csproj
RUN dotnet publish MindMapMe.Api/MindMapMe.Api.csproj -c Release -o /app/publish

# ---- run ----
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://0.0.0.0:${PORT}
ENTRYPOINT ["dotnet", "MindMapMe.Api.dll"]
