"""Collect training songs with yt-dlp (audio stays local; it is never committed or published).

Usage: python ml/collect.py --per-genre 30 [--out ~/rg-data]
Writes <out>/audio/<id>.<ext> and <out>/manifest.json (id, title, genre, duration, split).
Idempotent: re-running tops the collection up to the requested size.
Never add Audius tracks here: the Audius API terms prohibit training models on their content.
"""
import argparse, json, os, random, re, subprocess, sys

ARTISTS = {
    "vocaloid": [
        "ハチ", "DECO*27", "ピノキオピー", "kemu", "wowaka", "じん", "40mP", "ナユタン星人", "Orangestar",
        "supercell", "いよわ", "Kanaria", "柊キライ", "バルーン", "n-buna", "syudou", "すりぃ", "ぬゆり",
        "cosMo@暴走P", "黒うさP", "みきとP", "Neru", "*Luna", "かいりきベア", "煮ル果実",
    ],
    "jpop": [
        "YOASOBI", "Ado", "King Gnu", "LiSA", "Aimer", "Official髭男dism", "Mrs. GREEN APPLE", "ヨルシカ",
        "ずっと真夜中でいいのに。", "Eve", "Vaundy", "back number", "あいみょん", "Creepy Nuts", "米津玄師",
        "RADWIMPS", "ClariS", "fripSide", "藍井エイル", "Kalafina", "緑黄色社会", "優里", "藤井風", "MAN WITH A MISSION", "UVERworld",
    ],
}
QUERY = {"vocaloid": "{a} 初音ミク MV", "jpop": "{a} MV"}
SKIP = re.compile(r"live|ライブ|cover|歌ってみた|弾いてみた|叩いてみた|踊ってみた|medley|メドレー|album|作業用|耐久|hour|"
                  r"instrumental|off ?vocal|karaoke|カラオケ|reaction|tutorial|teaser|trailer|short|切り抜き|remix|ver\.|piano|acoustic", re.I)
MIN_S, MAX_S = 120, 420


def ytdlp(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["yt-dlp", "--no-warnings", *args], capture_output=True, text=True)


def search(artist: str, genre: str, n: int) -> list[dict]:
    r = ytdlp("--flat-playlist", "-J", "--", f"ytsearch{n}:{QUERY[genre].format(a=artist)}")
    if r.returncode != 0:
        return []
    out = []
    for e in json.loads(r.stdout).get("entries", []):
        d, title = e.get("duration") or 0, e.get("title") or ""
        if MIN_S <= d <= MAX_S and not SKIP.search(title):
            out.append({"id": e["id"], "title": title, "duration": d})
    return out


def download(vid: str, audio_dir: str) -> str | None:
    existing = [f for f in os.listdir(audio_dir) if f.startswith(vid + ".")]
    if existing:
        return existing[0]
    r = ytdlp("--no-playlist", "-f", "bestaudio", "-o", os.path.join(audio_dir, "%(id)s.%(ext)s"),
              "--", f"https://www.youtube.com/watch?v={vid}")
    if r.returncode != 0:
        print(f"  skip {vid}: {r.stderr.strip().splitlines()[-1][:120] if r.stderr.strip() else 'failed'}", file=sys.stderr)
        return None
    files = [f for f in os.listdir(audio_dir) if f.startswith(vid + ".") and not f.endswith(".part")]
    return files[0] if files else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-genre", type=int, default=30)
    ap.add_argument("--per-artist", type=int, default=2)
    ap.add_argument("--out", default=os.path.expanduser("~/rg-data"))
    a = ap.parse_args()
    audio_dir = os.path.join(a.out, "audio")
    os.makedirs(audio_dir, exist_ok=True)
    man_path = os.path.join(a.out, "manifest.json")
    songs = json.load(open(man_path)) if os.path.exists(man_path) else []
    have = {s["id"] for s in songs}
    titles = {s["title"].lower() for s in songs}

    for genre, artists in ARTISTS.items():
        count = sum(1 for s in songs if s["genre"] == genre)
        rounds = 1
        while count < a.per_genre and rounds <= 4:
            for artist in artists:
                if count >= a.per_genre:
                    break
                taken = sum(1 for s in songs if s.get("artist") == artist)
                if taken >= a.per_artist * rounds:
                    continue
                for c in search(artist, genre, 8 * rounds):
                    if c["id"] in have or c["title"].lower() in titles:
                        continue
                    f = download(c["id"], audio_dir)
                    if not f:
                        continue
                    songs.append({**c, "artist": artist, "genre": genre, "file": f})
                    have.add(c["id"]); titles.add(c["title"].lower())
                    count += 1
                    print(f"[{genre} {count}/{a.per_genre}] {artist}: {c['title'][:60]}", flush=True)
                    json.dump(songs, open(man_path, "w"), ensure_ascii=False, indent=1)
                    break
            rounds += 1

    # stable split by artist so no artist appears in both train and evaluation
    rng = random.Random(7)
    artists = sorted({s["artist"] for s in songs})
    rng.shuffle(artists)
    n = len(artists)
    role = {ar: ("test" if i < max(2, n // 8) else "val" if i < max(4, n // 4) else "train") for i, ar in enumerate(artists)}
    for s in songs:
        s["split"] = role[s["artist"]]
    json.dump(songs, open(man_path, "w"), ensure_ascii=False, indent=1)
    from collections import Counter
    print("done:", len(songs), dict(Counter(s["split"] for s in songs)), dict(Counter(s["genre"] for s in songs)))


if __name__ == "__main__":
    main()
