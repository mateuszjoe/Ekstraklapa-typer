import { Head, Html, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="pl">
      <Head>
        <link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/favicon-32.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/assets/brand/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="stylesheet" href="/styles.css" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
