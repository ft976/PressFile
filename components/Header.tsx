'use client';

import Link from 'next/link';
import { Minimize2 } from 'lucide-react';

interface HeaderProps {
  onTriggerUpload: () => void;
}

export default function Header({ onTriggerUpload }: HeaderProps) {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-8 px-4 py-4 sm:px-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2.5 text-lg font-semibold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600"
        >
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-blue-600 text-white">
            <Minimize2 className="h-4 w-4" aria-hidden="true" />
          </span>
          <span>PressFile</span>
        </Link>

        <button
          type="button"
          onClick={onTriggerUpload}
          className="inline-flex min-h-10 items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white whitespace-nowrap shrink-0 transition-colors duration-150 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Select File
        </button>
      </div>
    </header>
  );
}
