Score-Based Progress Tracker (SBPT)
🚀 Overview
The Score-Based Progress Tracker (SBPT) is a single-page web application designed to gamify personal productivity by assigning value-based scores to tasks. Instead of just tracking task completion, SBPT emphasizes the quality and importance of work by encouraging the completion of high-value tasks (10 points) over low-value tasks (1 point).

The application provides real-time metrics, motivation features like a Daily Streak, and immediate feedback through a customizable Daily Goal.

✨ Key Features
This application combines task management with engaging metrics to drive motivation:

Value-Weighted Scoring: Tasks are assigned point values of 1 (Low), 5 (Medium), or 10 (High).

Daily Streak Counter: Tracks consecutive days with at least one completed task, encouraging daily engagement.

Daily Score Goal: Users can set a target score (e.g., 50 points) for the current day, with the dashboard visually confirming when the goal is achieved.

Real-Time Metrics:

Today's Score: Points earned today.

Lifetime Score: Total points earned since the beginning.

7-Day Score: Points earned over the last week.

VvV Ratio (Value-vs-Volume): Calculates the average point value per task completed, serving as a quality metric to ensure focus on high-value items.

Persistent Storage: All tasks, scores, and user profile information (username, streak, daily goal) are stored securely using Google Cloud Firestore.

Responsive Design: Built with Tailwind CSS for optimal viewing on mobile and desktop devices.

🛠️ Technology Stack
Component

Technology

Role

Frontend

HTML5, JavaScript, Tailwind CSS

Single-page application structure and responsive styling.

Backend/DB

Google Cloud Firestore

Real-time, NoSQL database for tasks and user data.

Authentication

Firebase Auth

Handles secure user sign-in (anonymous or with custom token).

⚙️ Setup and Installation
Since this is a single HTML file application, setup is simple but requires configuration of a Firebase project.

1. Firebase Project Setup
Create a new project in the Firebase Console.

Enable Anonymous sign-in under Authentication.

Create a new Firestore Database (start in test mode for simplicity).

Add a Web App to your project to get your Firebase Configuration Object (apiKey, projectId, etc.).

2. Deploying the Application
The application is designed to be run within the development environment which automatically injects the necessary Firebase configuration and authentication token.

To run this file locally, you would typically need to manually insert the Firebase configuration into the script tag:

// Example of required global variables for the canvas environment
const appId = 'your-canvas-app-id';
const firebaseConfig = { /* PASTE YOUR FIREBASE CONFIG HERE */ };
const initialAuthToken = null; // or your custom token

3. Firestore Security Rules
To ensure proper data isolation and security, your Firestore rules must enforce that users can only read and write to their own private data path.

The application uses the following path structure:
artifacts/{appId}/users/{userId}/tasks
artifacts/{appId}/users/{userId}/profile/info

You must ensure that the rules allow authenticated users (request.auth != null) to access documents where the {userId} matches their own UID (request.auth.uid).

✍️ Usage
Add a Task: Use the form on the left to input a description, select a point value (1, 5, or 10), and optionally set a target date.

Set Daily Goal: Click the Daily Goal Progress metric card on the dashboard to set your daily point target.

Complete a Task: Check the box next to a task in the active list. This awards the points, contributes to your streak, and updates all dashboard metrics instantly.

Set Username: Click the user display button in the top right to set a personal username, which is saved to your profile.
