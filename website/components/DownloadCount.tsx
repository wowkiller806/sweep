import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

const DownloadCount: React.FC = () => {
    const [downloads, setDownloads] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchDownloads = async () => {
            try {
                // Fetch downloads from 2025-11-15 (project launch) to today
                const today = new Date().toISOString().split('T')[0];
                const response = await fetch(
                    `https://api.npmjs.org/downloads/range/2025-11-15:${today}/sweepp`
                );

                if (!response.ok) {
                    throw new Error('Failed to fetch downloads');
                }

                const data = await response.json();

                // Sum up all daily downloads
                const total = data.downloads.reduce((acc: number, day: { downloads: number }) => acc + day.downloads, 0);

                setDownloads(total);
            } catch (error) {
                console.error('Error fetching download count:', error);
                setDownloads(null);
            } finally {
                setLoading(false);
            }
        };

        fetchDownloads();
    }, []);

    if (loading || downloads === null) return null;

    return (
        <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs font-medium text-clay-400 hover:text-white hover:bg-white/10 transition-all duration-300 cursor-default group">
            <Download className="w-3.5 h-3.5 group-hover:text-accent transition-colors" />
            <span>
                <span className="text-white font-semibold group-hover:text-accent transition-colors">
                    {new Intl.NumberFormat('en-US', { notation: "compact", compactDisplay: "short" }).format(downloads)}
                </span>
                {' '}downloads
            </span>
        </div>
    );
};

export default DownloadCount;
