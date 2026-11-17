// The search box at the top of every admin page: it opens the admin Search page with the words typed.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

export default function AdminSearchBox() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const go = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length >= 2) nav(`/admin/search?q=${encodeURIComponent(q.trim())}`);
  };
  return (
    <form className="adm-topsearch" role="search" onSubmit={go}>
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search every world…" aria-label="Search every world" />
    </form>
  );
}
