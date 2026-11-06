# 🎨 AI Thumbnail Generator

An AI-powered thumbnail generation web application designed to help content creators create eye-catching thumbnails with less manual effort.

Built with **React, TypeScript, Node.js, and Express**, the application provides an interface for generating, previewing, and managing thumbnails.

## 🚀 Features

- **AI-Powered Thumbnail Generation** – Generate thumbnail designs using AI-powered functionality.
- **User Authentication** – Login and user account management.
- **Thumbnail Customization** – Options for selecting styles, color schemes, and aspect ratios.
- **Thumbnail Preview** – Preview thumbnail designs through an interactive interface.
- **My Generations** – Dedicated section for managing generated thumbnails.
- **Responsive Design** – Interface designed for different screen sizes.
- **Backend API** – Server-side functionality for authentication, generation, and user management.

## 🛠️ Tech Stack

| Category | Technologies |
|---|---|
| Frontend | React, TypeScript, Vite |
| Backend | Node.js, Express, TypeScript |
| Version Control | Git, GitHub |
| Architecture | Client–Server |

The project also includes integrations and configuration modules for AI functionality, database connectivity, and image storage.

## 📁 Project Structure

```text
Thumbnail_generator/
│
├── client/
│   ├── public/
│   ├── src/
│   │   ├── assets/
│   │   ├── components/
│   │   ├── configs/
│   │   ├── context/
│   │   ├── data/
│   │   ├── pages/
│   │   └── sections/
│   ├── package.json
│   └── vite.config.ts
│
├── server/
│   ├── assets/
│   ├── configs/
│   ├── controllers/
│   ├── middlewares/
│   ├── models/
│   ├── routes/
│   ├── package.json
│   └── server.ts
│
├── .gitignore
└── README.md
```

## ⚙️ Installation and Setup

### Prerequisites

Make sure you have installed:

- Node.js
- npm
- Git

### 1. Clone the Repository

```bash
git clone https://github.com/atulk883675/Thumbnail_generator.git
```

```bash
cd Thumbnail_generator
```

### 2. Install Frontend Dependencies

```bash
cd client
npm install
```

### 3. Install Backend Dependencies

Open another terminal in the project root:

```bash
cd server
npm install
```

### 4. Configure Environment Variables

Create the necessary `.env` files for your frontend and backend according to their configuration requirements.

Add your own API credentials, database connection information, and other required environment variables.

**Never commit real API keys, passwords, or `.env` files to GitHub.**

### 5. Run the Application

From the frontend directory:

```bash
npm run dev
```

From the backend directory, run the development script defined in `server/package.json`.

## 📸 Screenshots

Screenshots of the application interface will be added here.

## 🔮 Future Improvements

- Additional thumbnail templates
- Enhanced AI-based customization
- More editing options
- Improved thumbnail management
- Performance optimization

## 👨‍💻 Author

**GitHub:** [atulk883675](https://github.com/atulk883675)

## ⭐ Support

If you find this project useful, consider giving the repository a star!
