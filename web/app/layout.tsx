import './globals.css';
import { Toaster } from 'sonner';

export const metadata = { title: 'KIVO — 知识管理', description: 'KIVO Knowledge Management System' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
