import axios from 'axios';

const api = axios.create({
    baseURL: import.meta.env.VITE_BASE_URL || 'http://localhost:3000',
    withCredentials: true
})

export default api;

// Download link for a thumbnail. Cloudinary URLs use fl_attachment; images served
// by our own server use ?download (see server/configs/storage.ts).
export const toDownloadUrl = (imageUrl: string) => {
    if (imageUrl.includes('res.cloudinary.com')) return imageUrl.replace('/upload', '/upload/fl_attachment');
    const url = new URL(imageUrl);
    url.searchParams.set('download', '1');
    return url.toString();
};