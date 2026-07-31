using System.Text.Json;

namespace ClipSync;

// Configuration locale, persistée dans %APPDATA%\ClipSync\config.json.
// Une seule chose à renseigner : la « phrase de couplage » (identique sur tous les appareils).
public sealed class Config
{
    public string ServerUrl { get; set; } = "wss://clipsync.lateliercbd.com/ws";
    public string HttpUrl { get; set; } = "https://clipsync.lateliercbd.com";
    public string Phrase { get; set; } = ""; // relie les appareils + chiffre ; jamais envoyée telle quelle
    public string DeviceId { get; set; } = "";
    public string DeviceName { get; set; } = Environment.MachineName;

    static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "ClipSync", "config.json");

    public static Config Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var loaded = JsonSerializer.Deserialize<Config>(File.ReadAllText(FilePath));
                if (loaded is not null) return loaded.EnsureDefaults();
            }
        }
        catch { /* fichier corrompu : on repart d'une config neuve */ }

        return new Config().EnsureDefaults();
    }

    Config EnsureDefaults()
    {
        if (string.IsNullOrEmpty(DeviceId)) DeviceId = "pc-" + Guid.NewGuid().ToString("N")[..8];
        if (string.IsNullOrEmpty(DeviceName)) DeviceName = Environment.MachineName;
        if (string.IsNullOrEmpty(ServerUrl)) ServerUrl = "wss://clipsync.lateliercbd.com/ws";
        if (string.IsNullOrEmpty(HttpUrl)) HttpUrl = "https://clipsync.lateliercbd.com";
        // clip.lateliercbd.com n'existe plus : les config.json deja ecrits doivent suivre.
        ServerUrl = ServerUrl.Replace("clip.lateliercbd.com", "clipsync.lateliercbd.com");
        HttpUrl = HttpUrl.Replace("clip.lateliercbd.com", "clipsync.lateliercbd.com");
        Save();
        return this;
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { /* best effort */ }
    }

    public bool IsConfigured => !string.IsNullOrWhiteSpace(Phrase);
}
