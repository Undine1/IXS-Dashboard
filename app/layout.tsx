import type { Metadata } from "next";
import "./globals.css";

const criticalFirstPaintCss = `
  :where(html, body) {
    min-height: 100%;
    background: #0b1120;
    color: #ededed;
    color-scheme: dark;
  }

  :where(body) {
    margin: 0;
    font-family: Arial, Helvetica, sans-serif;
  }

  :where(*, *::before, *::after) {
    box-sizing: border-box;
  }

  :where(.ixs-dashboard-shell) {
    min-height: 100vh;
    padding: 1rem;
    background: #0b1120;
  }

  :where(.ixs-dashboard-container) {
    width: 100%;
    max-width: 80rem;
    margin-inline: auto;
  }

  :where(.ixs-dashboard-hero) {
    margin-bottom: 2rem;
    overflow: hidden;
    border: 1px solid rgb(51 65 85 / 0.6);
    border-radius: 1.5rem;
    background: linear-gradient(135deg, #0f172a, #1e293b, #020617);
  }

  :where(.ixs-dashboard-hero-content) {
    display: grid;
    gap: 1.5rem;
    padding: 1.5rem;
  }

  :where(.ixs-dashboard-status-grid) {
    display: grid;
    gap: 0.75rem;
  }

  :where(.ixs-dashboard-status-card) {
    padding: 0.75rem 1rem;
    border: 1px solid rgb(255 255 255 / 0.15);
    border-radius: 1rem;
    background: rgb(255 255 255 / 0.06);
  }

  :where(.ixs-dashboard-loading) {
    padding-block: 2rem;
  }

  @media (min-width: 40rem) {
    :where(.ixs-dashboard-status-grid) {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  @media (min-width: 48rem) {
    :where(.ixs-dashboard-shell) {
      padding: 2rem;
    }

    :where(.ixs-dashboard-hero-content) {
      padding: 2rem;
    }
  }
`;

export const metadata: Metadata = {
  title: "IXS Statistics",
  description: "IXS burn telemetry, cross-chain liquidity, and platform volume statistics.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" style={{ backgroundColor: "#0b1120", colorScheme: "dark" }}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: criticalFirstPaintCss }} />
      </head>
      <body
        className="antialiased"
        style={{
          minHeight: "100%",
          margin: 0,
          backgroundColor: "#0b1120",
          color: "#ededed",
          fontFamily: "Arial, Helvetica, sans-serif",
        }}
      >
        {children}
      </body>
    </html>
  );
}
