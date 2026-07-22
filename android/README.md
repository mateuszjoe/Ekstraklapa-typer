# Ekstraklapa Typer na Androida

Projekt buduje podpisany APK `pl.ekstraklapatyper.app` w oparciu o Android Browser Helper. Aplikacja uruchamia produkcyjną PWA w Trusted Web Activity, z bezpiecznym przejściem do Custom Tab, gdy domena nie ma jeszcze pełnej weryfikacji Digital Asset Links.

## Wydanie

- `versionCode`: `3`
- `versionName`: `1.0.2`
- minimalny Android: 6.0 (API 23)
- docelowy Android: API 35
- adres: `https://mateuszjoe.github.io/Ekstraklapa-typer/`

Wydania muszą używać tego samego klucza i rosnącego `versionCode`. Klucz nie może trafić do repozytorium. Workflow `.github/workflows/android-apk.yml` odtwarza go z sekretów GitHuba i publikuje podpisany artefakt do weryfikacji.

Pełny tryb bez paska przeglądarki wymaga pliku `https://mateuszjoe.github.io/.well-known/assetlinks.json` zawierającego package ID oraz SHA-256 certyfikatu podpisującego. Do czasu skonfigurowania pliku aplikacja działa jako bezpieczny Custom Tab, dzięki czemu logowanie Google nie korzysta z zabronionego WebView.
