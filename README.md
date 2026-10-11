# School Management System (MVP)

A modern, responsive Minimum Viable Product for a School Management System.

## Features Included
1. **Authentication System**: Secure admin login (`admin` / `admin123`).
2. **Dashboard**: Overview cards for total students, teachers, and classes.
3. **Student Management**: Full CRUD operations for managing students.
4. **Teacher Management**: Full CRUD operations for managing teachers.
5. **Class Management**: Create and structure classes, assign teachers.
6. **Basic Attendance**: Mark students as Present/Absent for any day.
7. **Clean UI/UX**: Built with vanilla CSS using modern CSS variables, flexbox, grid, and FontAwesome icons, with a robust Single Page Application (SPA) architecture using pure JavaScript.

## Stack
- **Frontend**: HTML5, CSS3, JavaScript (Vanilla ES6)
- **Backend**: Node.js, Express.js
- **Database**: SQLite3 (Embedded Database, requires no setup)

## Setup Instructions

### Prerequisites
- Node.js installed on your computer.

### Installation
1. Open up your terminal / command prompt.
2. Navigate to this project folder.
3. Install the dependencies by running:
    ```bash
    npm install
    ```
4. Start the server by running:
    ```bash
    node backend/server.js
    ```
   *(Alternatively, run `npm run dev` if you have `nodemon` installed globally).*

### Accessing the App
- Open your browser and navigate to: `http://localhost:3000`
- The default **Admin Login** credentials are:
  - **Username:** `admin`
  - **Password:** `admin123`
  *(Dummy data for students and teachers will be automatically generated on first boot).*

Enjoy managing the school!
