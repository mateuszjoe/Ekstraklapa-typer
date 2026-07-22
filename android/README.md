# Ekstraklapa Typer na Androida

Projekt buduje podpisany APK `pl.ekstraklapatyper.app` w oparciu o Android Browser Helper. Aplikacja uruchamia produkcyjną PWA w zweryfikowanym Trusted Web Activity.

## Wydanie

- `versionCode`: `3`
- `versionName`: `1.0.2`
- minimalny Android: 6.0 (API 23)
- docelowy Android: API 35
- adres: `https://mateuszjoe.github.io/Ekstraklapa-typer/`

Wydania muszą używać tego samego klucza i rosnącego `versionCode`. Klucz nie może trafić do repozytorium. Workflow `.github/workflows/android-apk.yml` odtwarza go z sekretów GitHuba i publikuje podpisany artefakt do weryfikacji.

Weryfikację zapewnia `https://mateuszjoe.github.io/.well-known/assetlinks.json`, publikowany z technicznego repozytorium `mateuszjoe/mateuszjoe.github.io`. Plik zawiera package ID oraz SHA-256 certyfikatu podpisującego.

Wybieranie zdjęć do avatara i chatu korzysta z systemowego pickera, dlatego aplikacja nie prosi o stały dostęp do galerii ani pamięci. Powiadomienia czatu są opcjonalne i wymagają świadomego włączenia przez użytkownika.
