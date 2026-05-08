import './globals.css';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';

export const metadata = { title: 'KIVO — 知识管理', description: 'KIVO Knowledge Management System' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" forcedTheme="light">
          {children}
          <Toaster richColors position="top-right" theme="system" />
        </ThemeProvider>
      </body>
    </html>
  );
}
