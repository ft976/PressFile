import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'PressFile — Simple Document, Image & File Compressor',
  description:
    'Compress DOCX, PPTX, PDF, images, and any file format in a clean, fast light interface.',
  openGraph: {
    title: 'PressFile — Simple Document, Image & File Compressor',
    description:
      'Compress DOCX, PPTX, PDF, images, and any file format in a clean, fast light interface.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PressFile — Simple Document, Image & File Compressor',
    description:
      'Compress DOCX, PPTX, PDF, images, and any file format in a clean, fast light interface.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${plusJakarta.variable} ${jetbrainsMono.variable}`}
    >
      <body
        className="min-h-screen bg-white text-slate-900 font-sans antialiased selection:bg-blue-100 selection:text-slate-900"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
