import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, getDoc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, where, serverTimestamp, getDocs } from 'firebase/firestore';
import { setLogLevel } from 'firebase/firestore';

// Set Firebase log level for debugging purposes
// setLogLevel('Debug');

// --- GLOBAL CONSTANTS & CONFIG (from HTML file) ---
const MAX_TASK_BUDGET = 50; 
const HIGH_VALUE_PHASE_2_POINTS = 100;
const MIN_RECOMMENDED_DAILY_GOAL = 10; 

// Retrieve global variables provided by the environment
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null; 

// Utility Functions 
function getWeekStart(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0); 
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); 
    return new Date(d.setDate(diff));
}
function getMonthStart(date) {
    const d = new Date(date);
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
    monthStart.setHours(0, 0, 0, 0);
    return monthStart;
}
function getYearStart(date) {
    const d = new Date(date);
    const yearStart = new Date(d.getFullYear(), 0, 1);
    yearStart.setHours(0, 0, 0, 0);
    return yearStart;
}
function isSameDay(d1, d2) {
    return d1.getFullYear() === d2.getFullYear() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getDate() === d2.getDate();
}
// --- END Utility Functions ---


/**
 * Calculates all current scores (daily, weekly, monthly, yearly)
 * based on the current day's completed tasks (dailyScore) and history.
 */
const calculatePeriodScores = (history, dailyScore) => {
    const now = new Date();
    const weekStart = getWeekStart(now);
    const monthStart = getMonthStart(now);
    const yearStart = getYearStart(now);
    
    let weeklyScore = dailyScore;
    let monthlyScore = dailyScore;
    let yearlyScore = dailyScore;

    history.forEach(item => {
        const itemDate = item.date?.toDate ? item.date.toDate() : new Date(item.date);
        
        // Only count scores from history if they were recorded BEFORE today.
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (!isSameDay(itemDate, today)) {
            if (itemDate >= weekStart) {
                weeklyScore += item.score;
            }
            if (itemDate >= monthStart) {
                monthlyScore += item.score;
            }
            if (itemDate >= yearStart) {
                yearlyScore += item.score;
            }
        }
    });

    return {
        daily: dailyScore,
        weekly: weeklyScore,
        monthly: monthlyScore,
        yearly: yearlyScore
    };
};

/**
 * Calculates the current daily streak of achieving the daily goal.
 */
const calculateStreak = (history, dailyGoal) => {
    if (history.length === 0 || dailyGoal === 0) return 0;

    let streak = 0;
    let currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);
    
    // NOTE: We only check the history for past days.

    const sortedHistory = [...history].sort((a, b) => {
        const dateA = a.date?.toDate ? a.date.toDate().getTime() : 0;
        const dateB = b.date?.toDate ? b.date.toDate().getTime() : 0;
        return dateB - dateA; // Latest scores first
    });

    // Start checking from yesterday backwards
    let expectedDate = new Date();
    expectedDate.setDate(currentDate.getDate() - 1);
    expectedDate.setHours(0, 0, 0, 0);

    for (const item of sortedHistory) {
        const itemDate = item.date?.toDate ? item.date.toDate() : new Date(item.date);
        itemDate.setHours(0, 0, 0, 0);

        if (isSameDay(itemDate, expectedDate) && item.score >= dailyGoal && dailyGoal > 0) {
            streak++;
            expectedDate.setDate(expectedDate.getDate() - 1); // Move to the previous day
        } else if (itemDate < expectedDate) {
            // Found a gap or the streak was broken earlier
            break;
        }
    }

    return streak;
};


// --- CORE APPLICATION COMPONENT ---
export default function App() {
    // --- STATE MANAGEMENT ---
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState('anonymous');
    const [tasks, setTasks] = useState([]);
    const [scoreHistory, setScoreHistory] = useState([]);
    const [goals, setGoals] = useState({ daily: 0, weekly: 0, monthly: 0, yearly: 0 });
    const [uiState, setUiState] = useState({ 
        welcomeHidden: false, 
        currentView: 'tracker',
        currentPeriod: 'daily',
        isFilterActive: false,
        message: null, // Custom message box state
    });

    const [modalOpen, setModalOpen] = useState(null); // 'goal', 'reset', 'masterReset'
    const [taskFormInput, setTaskFormInput] = useState({ name: '', points: '' });


    // --- MEMOIZED CALCULATIONS ---

    const dailyScore = useMemo(() => {
        return tasks.filter(t => t.completed).reduce((sum, t) => sum + (t.points || 0), 0);
    }, [tasks]);

    const periodScores = useMemo(() => {
        return calculatePeriodScores(scoreHistory, dailyScore);
    }, [scoreHistory, dailyScore]);
    
    // NEW MVP FEATURE: Streak Counter
    const dailyStreak = useMemo(() => {
        // Streak counter needs to consider the current day's progress if the goal is met
        const historyWithToday = scoreHistory.some(h => isSameDay(h.date?.toDate ? h.date.toDate() : new Date(h.date), new Date())) 
            ? scoreHistory 
            : [...scoreHistory, { score: dailyScore, date: serverTimestamp() }];

        // Re-calculate the streak, potentially including the current day if the goal is met
        let streak = calculateStreak(historyWithToday, goals.daily);
        
        // If the current day's score is >= daily goal, the streak counts today too, 
        // but the standard calculateStreak only counts past days saved in history.
        // Let's manually check the current day state for a more accurate streak display.
        if (goals.daily > 0 && dailyScore >= goals.daily) {
             // If today's goal is met, and yesterday was met (which is checked by calculateStreak), 
             // we should increment the streak displayed, as the current day score hasn't hit history yet.
             // This can be complex, let's keep it simple: if daily goal is met, show streak + 1 (for today)
             // UNLESS it's already recorded in history (which is complicated to check perfectly).
             
             // Simplest safe approach: If today's goal is met, and it's not yet archived in history,
             // and yesterday was part of the streak, increment the visible streak.
             const yesterday = new Date();
             yesterday.setDate(yesterday.getDate() - 1);
             yesterday.setHours(0, 0, 0, 0);

             const historyAchievedYesterday = scoreHistory.some(item => {
                const itemDate = item.date?.toDate ? item.date.toDate() : new Date(item.date);
                itemDate.setHours(0, 0, 0, 0);
                return isSameDay(itemDate, yesterday) && item.score >= goals.daily;
             });

             if (goals.daily > 0 && dailyScore >= goals.daily) {
                if (streak > 0 || scoreHistory.length === 0) {
                    // If streak is already > 0 (meaning yesterday was achieved) OR if this is the very first day
                    return streak + 1;
                }
             }

        }

        return calculateStreak(scoreHistory, goals.daily);

    }, [scoreHistory, goals.daily, dailyScore]);


    const currentBudgetPoints = useMemo(() => {
        return tasks.filter(t => !t.completed && t.points !== HIGH_VALUE_PHASE_2_POINTS)
                    .reduce((sum, t) => sum + (t.points || 0), 0);
    }, [tasks]);

    // --- FIREBASE UTILITIES ---

    const getUserCollectionPath = (collectionName) => {
        return `artifacts/${appId}/users/${userId}/${collectionName}`;
    };

    // --- FIREBASE INITIALIZATION & AUTH ---

    useEffect(() => {
        if (!firebaseConfig) {
            console.error("Firebase config not available.");
            return;
        }

        try {
            const app = initializeApp(firebaseConfig);
            const firestoreDb = getFirestore(app);
            const firebaseAuth = getAuth(app);
            setDb(firestoreDb);
            setAuth(firebaseAuth);

            const authenticate = async () => {
                try {
                    if (initialAuthToken) {
                        await signInWithCustomToken(firebaseAuth, initialAuthToken);
                    } else {
                        await signInAnonymously(firebaseAuth);
                    }
                } catch (error) {
                    console.error("Authentication failed:", error);
                }
            };
            authenticate();

            // Set up Auth State Listener
            onAuthStateChanged(firebaseAuth, (user) => {
                if (user) {
                    setUserId(user.uid);
                    console.log("Authentication successful. User ID:", user.uid);
                } else {
                    setUserId('anonymous');
                    console.log("No user signed in.");
                }
            });

        } catch (error) {
            console.error("Firebase initialization error:", error);
        }
    }, []);

    // --- FIRESTORE LISTENERS ---

    useEffect(() => {
        if (!db || userId === 'anonymous') return;

        // 1. Task Listener
        const tasksUnsubscribe = onSnapshot(collection(db, getUserCollectionPath('tasks')), (snapshot) => {
            const loadedTasks = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setTasks(loadedTasks);
        }, (error) => console.error("Error listening to tasks:", error));

        // 2. Goal Listener
        const goalDocRef = doc(db, getUserCollectionPath('settings'), 'goals');
        const goalsUnsubscribe = onSnapshot(goalDocRef, (docSnapshot) => {
            if (docSnapshot.exists()) {
                const data = docSnapshot.data();
                setGoals({
                    daily: parseInt(data.dailyGoal, 10) || 0,
                    weekly: parseInt(data.weeklyGoal, 10) || 0,
                    monthly: parseInt(data.monthlyGoal, 10) || 0,
                    yearly: parseInt(data.yearlyGoal, 10) || 0,
                });
            } else {
                setGoals({ daily: 0, weekly: 0, monthly: 0, yearly: 0 });
            }
        }, (error) => console.error("Error listening to goals:", error));
        
        // 3. Score History Listener
        const historyUnsubscribe = onSnapshot(collection(db, getUserCollectionPath('scoreHistory')), (snapshot) => {
            const loadedHistory = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            // Sort history by date descending in memory
            loadedHistory.sort((a, b) => {
                const dateA = a.date?.toDate ? a.date.toDate().getTime() : 0;
                const dateB = b.date?.toDate ? b.date.toDate().getTime() : 0;
                return dateB - dateA; // Latest scores first
            });
            setScoreHistory(loadedHistory);
        }, (error) => console.error("Error listening to score history:", error));
        
        // 4. UI State Listener (for welcome card dismissal)
        const uiDocRef = doc(db, getUserCollectionPath('settings'), 'ui_state');
        const uiUnsubscribe = onSnapshot(uiDocRef, (docSnapshot) => {
            if (docSnapshot.exists()) {
                setUiState(prev => ({ ...prev, welcomeHidden: docSnapshot.data().welcomeHidden || false }));
            }
        }, (error) => console.error("Error listening to UI state:", error));


        return () => {
            tasksUnsubscribe();
            goalsUnsubscribe();
            historyUnsubscribe();
            uiUnsubscribe();
        };
    }, [db, userId]);


    // --- FIREBASE DATA OPERATIONS (Wrapped in useCallback) ---

    const showMessage = useCallback((title, content, colorClass = 'text-indigo-600') => {
        setUiState(prev => ({ ...prev, message: { title, content, colorClass } }));
    }, []);

    const toggleTaskCompletion = useCallback(async (taskId, isCompleted) => {
        if (!db || userId === 'anonymous') return;
        
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        try {
            const taskDocRef = doc(db, getUserCollectionPath('tasks'), taskId);
            await updateDoc(taskDocRef, { completed: isCompleted });
            
            // Instant Feedback
            const scoreChange = task.points;
            const color = isCompleted ? 'text-green-600' : 'text-red-600';
            const title = isCompleted ? 'Task Completed!' : 'Task Reopened';
            const sign = isCompleted ? '+' : '';

            showMessage(
                title, 
                `<p><strong>${task.name}</strong> ${isCompleted ? 'finished' : 'reopened'}!</p>
                 <p class="mt-3 text-xl font-bold ${color}">Score: ${sign}${scoreChange} Points</p>`,
                isCompleted ? 'text-green-600' : 'text-yellow-600'
            );

        } catch (e) { console.error("Error updating task: ", e); }
    }, [db, userId, tasks, showMessage]);

    const deleteTask = useCallback(async (taskId) => {
        if (!db || userId === 'anonymous') return;
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        try {
            const taskDocRef = doc(db, getUserCollectionPath('tasks'), taskId);
            await deleteDoc(taskDocRef);
            showMessage("Task Deleted", `<p><strong>${task.name} (${task.points} Pts)</strong> was successfully removed from your list.</p>`, 'text-gray-600');
        } catch (e) { console.error("Error deleting task: ", e); }
    }, [db, userId, tasks, showMessage]);

    const addTask = useCallback(async (name, points) => {
        if (!db || userId === 'anonymous') return;

        const pointValue = parseInt(points, 10);
        
        // Safety Valve Check (Future Project)
        if (pointValue === HIGH_VALUE_PHASE_2_POINTS) {
            showMessage(
                "Acknowledged: Future Project", 
                `<p>Thank you for submitting <strong>${name}</strong>! This project is acknowledged.</p>
                <p class="mt-3">To maintain focus, the tracker is currently optimized for tasks worth 1-10 points. Please focus on completing your current, smaller tasks first!</p>`,
                'text-indigo-600'
            );
            return;
        }

        // Regular Budget Check
        if (currentBudgetPoints + pointValue > MAX_TASK_BUDGET) {
            showMessage(
                "Budget Limit Reached", 
                `<p>You are at your <strong>${MAX_TASK_BUDGET}-point active limit</strong> for unfinished tasks.</p>
                <p class="mt-3">To add <strong>${name} (${pointValue} Pts)</strong>, please complete or delete existing tasks to free up budget space.</p>`,
                'text-red-600'
            );
            return; 
        }

        try {
            const tasksRef = collection(db, getUserCollectionPath('tasks'));
            await addDoc(tasksRef, {
                name: name, points: pointValue, completed: false, createdAt: serverTimestamp(), userId: userId 
            });
            showMessage("Task Added!", `<strong>${name}</strong> was added to your list.`, 'text-green-600');
            // Clear input fields only on successful addition
            setTaskFormInput({ name: '', points: '' });
        } catch (e) { console.error("Error adding document: ", e); }
    }, [db, userId, currentBudgetPoints, showMessage]);
    
    // Function to save goal (Used by GoalModal)
    const saveGoal = useCallback(async (target, frequency) => {
        if (!db || userId === 'anonymous') return;

        try {
            const goalDocRef = doc(db, getUserCollectionPath('settings'), 'goals');
            const data = {};
            data[`${frequency}Goal`] = parseInt(target, 10);
            await setDoc(goalDocRef, data, { merge: true });
            console.log(`${frequency} goal set successfully.`);
        } catch (e) { console.error("Error setting goal: ", e); }
    }, [db, userId]);


    // --- ARCHIVE & RESET LOGIC ---
    
    const archiveScore = useCallback(async (score) => {
        if (!db || userId === 'anonymous' || score === 0) return;

        try {
            const historyRef = collection(db, getUserCollectionPath('scoreHistory'));
            await addDoc(historyRef, {
                score: score,
                date: serverTimestamp(),
                goalAchieved: score >= goals.daily && goals.daily > 0,
                dailyGoal: goals.daily
            });
        } catch (e) { console.error("Error archiving score: ", e); }
    }, [db, userId, goals.daily]);


    const resetTasks = useCallback(async (deleteCompleted, deleteIncomplete) => {
        if (!db || userId === 'anonymous') return;
        
        const finalScore = dailyScore;

        if (finalScore > 0) {
            await archiveScore(finalScore);
        }
        
        try {
            const tasksRef = collection(db, getUserCollectionPath('tasks'));
            const snapshot = await getDocs(tasksRef);
            const deletions = [];

            snapshot.docs.forEach(d => {
                const task = d.data();
                const taskId = d.id;
                
                const shouldDelete = (task.completed && deleteCompleted) || (!task.completed && deleteIncomplete);
                
                if (shouldDelete) {
                    const taskDocRef = doc(db, getUserCollectionPath('tasks'), taskId);
                    deletions.push(deleteDoc(taskDocRef));
                }
            });

            await Promise.all(deletions);

            // Instant Feedback
            showMessage(
                "Daily Cleanup Complete!",
                `<p>Your final score of <strong>${finalScore} points</strong> has been archived to your Score History!</p>
                 <p class="mt-3">Your task list is now clean and ready for a new, highly-focused day.</p>`,
                 'text-indigo-600'
            );
            
        } catch (e) { console.error("Error during task reset/cleanup: ", e); }
    }, [db, userId, dailyScore, archiveScore, showMessage]);

    const masterReset = useCallback(async () => {
        if (!db || userId === 'anonymous') return;
        
        const deleteAllCollectionItems = async (collectionName) => {
            const collectionPath = getUserCollectionPath(collectionName);
            const snapshot = await getDocs(collection(db, collectionPath));
            const deletions = snapshot.docs.map(d => deleteDoc(doc(db, collectionPath, d.id)));
            await Promise.all(deletions);
        };

        try {
            await deleteAllCollectionItems('tasks');
            await deleteAllCollectionItems('scoreHistory');

            const goalDocRef = doc(db, getUserCollectionPath('settings'), 'goals');
            await setDoc(goalDocRef, { dailyGoal: 0, weeklyGoal: 0, monthlyGoal: 0, yearlyGoal: 0 });
            
            const uiDocRef = doc(db, getUserCollectionPath('settings'), 'ui_state');
            await setDoc(uiDocRef, { welcomeHidden: false });
            
            showMessage(
                "Master Reset Complete",
                `<p>All application data (Tasks, History, Goals) has been permanently wiped.</p>
                 <p class="mt-3 text-sm font-semibold text-red-500">You are starting completely fresh!</p>`,
                 'text-red-600'
            );
        } catch (e) { console.error("Error during master reset:", e); }
    }, [db, userId, showMessage]);


    // --- UI COMPONENTS ---
    
    // Component 1: Individual Task Item
    const TaskItem = ({ task }) => {
        const isCompleted = task.completed;
        const points = task.points || 1;
        const isPhase2 = points === HIGH_VALUE_PHASE_2_POINTS;
        
        let bgColor, pointColor, pointText;

        if (isPhase2) {
            bgColor = 'bg-indigo-100 border-indigo-300';
            pointColor = 'text-indigo-600';
            pointText = 'Future';
        } else if (isCompleted) {
            bgColor = 'bg-green-100 border-green-300';
            pointColor = 'text-gray-500';
            pointText = points;
        } else {
            bgColor = points === 10 ? 'bg-red-100 border-red-300' :
                      points === 5 ? 'bg-yellow-100 border-yellow-300' :
                      'bg-gray-100 border-gray-300';
            pointColor = points === 10 ? 'text-red-600' :
                         points === 5 ? 'text-yellow-600' :
                         'text-gray-600';
            pointText = points;
        }

        const completionClass = isCompleted ? 'line-through text-gray-500' : 'font-medium';
        const completionIcon = isPhase2 ? <i className="fas fa-hammer ml-1"></i> : <i className="fas fa-star ml-1"></i>;

        return (
            <div className={`flex items-center justify-between p-4 rounded-xl shadow-md transition duration-200 ${bgColor}`}>
                <div className="flex items-center flex-grow min-w-0">
                    <input 
                        type="checkbox" 
                        checked={isCompleted} 
                        disabled={isPhase2}
                        onChange={(e) => toggleTaskCompletion(task.id, e.target.checked)}
                        className={`task-toggle h-5 w-5 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500 ${isPhase2 ? 'cursor-not-allowed' : 'cursor-pointer'} mr-4`}
                    />
                    
                    <span className={`flex-grow min-w-0 truncate text-gray-800 ${completionClass}`}>
                        {task.name}
                    </span>
                    
                    <span className={`flex-shrink-0 ml-4 font-bold text-lg ${pointColor} flex items-center`}>
                        {pointText} {completionIcon}
                    </span>
                </div>
                
                <button 
                    onClick={() => deleteTask(task.id)}
                    className="task-delete-btn ml-4 text-gray-400 hover:text-red-500 transition duration-150 p-1 rounded-full">
                    <i className="fas fa-trash-alt"></i>
                </button>
            </div>
        );
    };

    // Component 2: Dynamic Goal Display (The large card)
    const DynamicGoalDisplay = ({ period, score, target }) => {
        const percentage = target > 0 ? Math.min(100, Math.floor((score / target) * 100)) : 0;
        const periodTitle = period.charAt(0).toUpperCase() + period.slice(1);
        
        const isAchieved = percentage >= 100;
        const barColor = isAchieved ? 'bg-green-500' : 'bg-indigo-400';
        const cardColor = isAchieved ? 'bg-green-600' : 'bg-indigo-600';
        const textColor = isAchieved ? 'text-green-600' : 'text-indigo-600';

        let statusText;
        if (target === 0) {
            statusText = `Set a ${period} goal to track progress!`;
        } else if (isAchieved) {
            statusText = `Goal Achieved! You exceeded your target by ${score - target} points.`;
        } else {
             statusText = `You need ${target - score} more points to reach your ${period} goal.`;
        }
        
        // Custom background colors for the selection tabs
        const periodColors = { daily: 'text-indigo-600', weekly: 'text-green-600', monthly: 'text-yellow-600', yearly: 'text-red-600' };

        return (
            <>
                {/* Goal Period Selector Tabs */}
                <div className="flex p-1 bg-gray-200 rounded-lg shadow-inner mb-4">
                    {['daily', 'weekly', 'monthly', 'yearly'].map(p => (
                        <button
                            key={p}
                            onClick={() => setUiState(prev => ({ ...prev, currentPeriod: p }))}
                            className={`flex-1 px-3 py-2 text-xs md:text-sm font-bold rounded-lg transition-all duration-200 focus:outline-none 
                                ${uiState.currentPeriod === p 
                                    ? 'bg-white text-indigo-700 shadow-lg border-b-4 border-indigo-500' 
                                    : `${periodColors[p]} hover:bg-gray-300`}`}
                            data-period={p}
                        >
                            {p.charAt(0).toUpperCase() + p.slice(1)}
                        </button>
                    ))}
                </div>

                {/* Goal Display Card */}
                <div className={`${cardColor} text-white p-6 rounded-xl shadow-lg transform transition-all duration-300`}>
                    <p className="text-sm md:text-lg font-bold mb-1 opacity-80">{periodTitle} Goal</p>
                    <p className="text-3xl md:text-4xl font-extrabold flex items-baseline">
                        {score} <span className="mx-2 text-3xl opacity-50">/</span> {target > 0 ? target : 'N/A'} <span className="text-lg font-medium opacity-80 ml-2">Points</span>
                    </p>
                </div>

                {/* Progress Bar and Details */}
                <div className="space-y-4 pt-4">
                    <div className="flex justify-between items-center text-gray-700">
                        <span className={`font-medium text-sm ${target === 0 ? 'text-gray-600' : isAchieved ? 'text-green-600' : 'text-red-600'}`}>{statusText}</span>
                        <span className={`font-bold text-lg ${textColor}`}>{percentage}%</span>
                    </div>

                    <div className="w-full bg-gray-200 rounded-full h-3 shadow-inner">
                        <div className={`h-3 rounded-full transition-all duration-500 ease-in-out ${barColor}`} style={{ width: `${percentage}%` }}></div>
                    </div>
                </div>
            </>
        );
    };
    
    // NEW MVP FEATURE COMPONENT: Goal Summary Panel
    const GoalSummaryPanel = ({ scores, goals, streak }) => {
        const periods = ['daily', 'weekly', 'monthly']; // Only show 3 main periods
        
        return (
            <section className="mb-6 p-4 bg-white rounded-xl border border-gray-200 shadow-md">
                <h2 className="text-xl font-bold text-gray-800 mb-3 flex items-center">
                    <i className="fas fa-gauge-high mr-2 text-indigo-600"></i> Performance Summary
                </h2>
                
                {/* Streak Counter */}
                <div className="bg-yellow-50 p-3 rounded-lg border border-yellow-300 mb-4 flex items-center justify-between">
                    <span className="font-semibold text-yellow-800 flex items-center">
                         <i className="fas fa-fire mr-2 text-red-500 animate-pulse"></i> Daily Goal Streak:
                    </span>
                    <span className="text-2xl font-extrabold text-red-600">{dailyScore >= goals.daily && goals.daily > 0 ? dailyStreak + 1 : dailyStreak} {dailyStreak === 1 ? 'Day' : 'Days'}</span>
                </div>

                <div className="grid grid-cols-3 gap-3">
                    {periods.map(period => {
                        const score = scores[period];
                        const target = goals[period];
                        const achieved = target > 0 && score >= target;
                        const bgColor = achieved ? 'bg-green-500' : 'bg-gray-700';
                        const icon = achieved ? 'fa-check' : 'fa-list-check';

                        return (
                            <div key={period} className={`${bgColor} text-white p-3 rounded-xl shadow-md text-center hover:shadow-lg transition`}>
                                <div className="text-xs font-semibold opacity-90">{period.toUpperCase()}</div>
                                <div className="text-lg font-bold mt-1 flex items-center justify-center">
                                    <i className={`fas ${icon} text-white text-opacity-80 mr-1 text-sm`}></i>
                                    {score} <span className="text-xs ml-1 opacity-75">/ {target > 0 ? target : '-'}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>
        );
    };


    // Component 3: Task Budget Display
    const TaskBudgetDisplay = () => {
        const usedPercentage = Math.min(100, (currentBudgetPoints / MAX_TASK_BUDGET) * 100);
        
        let statusText = 'Excellent capacity. Add more tasks!';
        let barClass = 'bg-green-500';
        
        if (usedPercentage >= 90) {
            statusText = 'Budget critical! You are nearly full.';
            barClass = 'bg-red-500';
        } else if (usedPercentage >= 70) {
            statusText = 'Budget warning. Prioritize carefully.';
            barClass = 'bg-yellow-500';
        }
        
        const isBudgetExceeded = currentBudgetPoints > MAX_TASK_BUDGET;

        return (
            <section className="mb-6 p-4 bg-white rounded-xl border border-gray-200 shadow-md">
                <h2 className="text-xl font-bold text-gray-800 mb-3 flex items-center">
                    <i className="fas fa-coins text-yellow-600 mr-2"></i> Task Budget
                </h2>
                <div className="flex justify-between items-center text-gray-700">
                    <span className="font-medium text-sm">{statusText}</span>
                    <span className={`font-bold text-lg ${isBudgetExceeded ? 'text-red-600' : 'text-indigo-600'}`}>{currentBudgetPoints} / {MAX_TASK_BUDGET} Pts</span>
                </div>
                {/* Budget Progress Bar */}
                <div className="w-full bg-gray-200 rounded-full h-3 shadow-inner mt-2">
                    <div className={`h-3 rounded-full transition-all duration-500 ease-in-out ${barClass}`} style={{ width: `${usedPercentage}%` }}></div>
                </div>
                <p className={`text-sm text-red-500 mt-2 ${isBudgetExceeded ? 'font-bold' : 'hidden'}`}>
                    Budget exceeded! Complete or delete tasks to free up points.
                </p>
            </section>
        );
    };

    // Component 4: Task List and Controls (The main view)
    const TrackerView = () => {
        const filteredTasks = uiState.isFilterActive 
            ? tasks.filter(t => t.points === 10)
            : tasks;

        // Sort: Incomplete, then by points descending
        const sortedTasks = [...filteredTasks].sort((a, b) => {
            if (a.completed && !b.completed) return 1;
            if (!a.completed && b.completed) return -1;
            return (b.points || 0) - (a.points || 0); 
        });

        // Handler for Task Form Submission
        const handleSubmit = (e) => {
            e.preventDefault();
            if (taskFormInput.name && taskFormInput.points) {
                addTask(taskFormInput.name, taskFormInput.points);
            }
        };

        // Handler for Focus/Filter Button
        const toggleFilter = () => {
            setUiState(prev => ({ ...prev, isFilterActive: !prev.isFilterActive }));
        };
        
        const filterBtnClasses = uiState.isFilterActive
            ? 'bg-red-500 hover:bg-red-600'
            : 'bg-green-500 hover:bg-green-600';
            
        const isTaskFormDisabled = currentBudgetPoints >= MAX_TASK_BUDGET && 
            parseInt(taskFormInput.points, 10) !== HIGH_VALUE_PHASE_2_POINTS;
            
        // Welcome Card (JSX)
        const WelcomeCard = () => (
            <div id="welcome-card" className="p-6 bg-indigo-50 border-2 border-indigo-300 rounded-xl shadow-lg space-y-3">
                <h3 className="text-xl font-bold text-indigo-700 flex items-center">
                    <i className="fas fa-hand-sparkles mr-2"></i> Welcome! Let's Get Started.
                </h3>
                <p className="text-gray-700">This is your personal productivity engine, based on <strong>Value-Weighted Scoring</strong>.</p>
                <ul className="list-disc list-inside space-y-1 text-gray-700 ml-4">
                    <li><strong className="text-indigo-600">Step 1:</strong> Click the <span className="font-mono text-xs bg-gray-200 p-1 rounded-md">Set Goal</span> button to define a Daily Target (we recommend 10 points).</li>
                    <li><strong className="text-indigo-600">Step 2:</strong> Add your first task below (use 10 points for your "Eat the Frog" task!).</li>
                </ul>
                <button 
                    onClick={() => {
                        // Persist state change
                        const uiDocRef = doc(db, getUserCollectionPath('settings'), 'ui_state');
                        setDoc(uiDocRef, { welcomeHidden: true }, { merge: true });
                    }}
                    className="w-full text-sm mt-3 py-2 bg-indigo-300 text-indigo-900 rounded-lg hover:bg-indigo-400 font-semibold transition">
                    Got It, Hide This Tip
                </button>
            </div>
        );

        if (tasks.length === 0 && scoreHistory.length === 0 && !uiState.welcomeHidden) {
            return <WelcomeCard />;
        }

        return (
            <>
                <GoalSummaryPanel 
                    scores={periodScores} 
                    goals={goals} 
                    streak={dailyStreak} 
                />
                
                <section className="mb-6 p-4 bg-white rounded-xl border border-gray-200 shadow-md">
                    <h2 className="text-xl font-bold text-gray-800 mb-4 flex items-center">
                        <i className="fas fa-bullseye mr-2 text-indigo-600"></i> Goal Progress
                    </h2>
                    <DynamicGoalDisplay 
                        period={uiState.currentPeriod} 
                        score={periodScores[uiState.currentPeriod]} 
                        target={goals[uiState.currentPeriod]} 
                    />
                </section>

                <TaskBudgetDisplay />

                {/* Set Goal and Productivity Filter */}
                <section className="mb-6 flex flex-col space-y-3 sm:flex-row sm:space-y-0 sm:space-x-3">
                     <button 
                        onClick={() => setModalOpen('goal')}
                        className="flex-1 bg-indigo-500 text-white py-3 px-4 rounded-xl font-bold shadow-lg hover:bg-indigo-600 transition duration-150 transform hover:scale-[1.01]">
                        <i className="fas fa-bullseye mr-2"></i> Set Goal
                    </button>
                    <button 
                        onClick={toggleFilter}
                        className={`flex-1 text-white py-3 px-4 rounded-xl font-bold shadow-lg transition duration-150 transform hover:scale-[1.01] ${filterBtnClasses}`}>
                        <i className="fas fa-filter mr-2"></i> 
                        {uiState.isFilterActive ? 'Exit Focus Mode' : 'Focus: High Value (10 pts)'}
                    </button>
                </section>

                {/* Add New Task Form */}
                <section className="mb-8 p-4 bg-gray-50 rounded-xl border border-gray-200 shadow-inner">
                    <h2 className="text-xl font-semibold text-gray-700 mb-3">Add a New Task</h2>
                    <form onSubmit={handleSubmit} className="space-y-3">
                        <input type="text" id="task-name" placeholder="E.g., Finish Q3 Report (10 points)" required
                               value={taskFormInput.name}
                               onChange={(e) => setTaskFormInput(prev => ({ ...prev, name: e.target.value }))}
                               className="w-full p-3 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500"/>
                        <select id="task-points" required
                                value={taskFormInput.points}
                                onChange={(e) => setTaskFormInput(prev => ({ ...prev, points: e.target.value }))}
                                className="w-full p-3 border border-gray-300 rounded-lg bg-white focus:ring-indigo-500 focus:border-indigo-500">
                            <option value="" disabled>Select Point Value (Prioritization)</option>
                            <option value="1">1 Point (Small Routine Task)</option>
                            <option value="5">5 Points (Medium/Important Task)</option>
                            <option value="10">10 Points (High Value / "Eat the Frog")</option>
                            <option value="100">100 Points (Future High-Value Project - Acknowledge Request)</option>
                        </select>
                        <button type="submit" 
                            disabled={isTaskFormDisabled}
                            className={`w-full py-3 rounded-xl font-bold transition duration-150 shadow-md ${isTaskFormDisabled ? 'bg-gray-400 cursor-not-allowed text-gray-700' : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}>
                            <i className="fas fa-plus-circle mr-2"></i> Add Task
                        </button>
                    </form>
                </section>

                {/* Task List */}
                <section className="mb-6">
                    <h2 className="text-2xl font-bold text-gray-800 mb-4">Your Tasks</h2>
                    <div className="task-list-container space-y-3 max-h-96 overflow-y-auto pr-2">
                        {sortedTasks.length === 0 ? (
                            <p className="text-center text-gray-500 py-6">
                                {uiState.isFilterActive ? 'No 10-point tasks match the current filter.' : 'All clear! Time to add a new task.'}
                            </p>
                        ) : (
                            sortedTasks.map(task => <TaskItem key={task.id} task={task} />)
                        )}
                    </div>
                </section>

                {/* Action Buttons (Daily Reset and Master Reset) */}
                <section className="space-y-3">
                    <button 
                        onClick={() => setModalOpen('reset')}
                        className="w-full bg-gray-300 text-gray-800 py-3 rounded-xl font-bold hover:bg-gray-400 transition duration-150 shadow-md transform hover:scale-[1.01]">
                        <i className="fas fa-broom mr-2"></i> Daily Task Clean-up
                    </button>
                    <button 
                        onClick={() => setModalOpen('masterReset')}
                        className="w-full bg-red-100 text-red-600 py-3 rounded-xl font-bold border-2 border-red-300 hover:bg-red-200 transition duration-150 shadow-md transform hover:scale-[1.01]">
                        <i className="fas fa-power-off mr-2"></i> MASTER RESET (Clear All Data)
                    </button>
                </section>
            </>
        );
    };


    // Component 5: Score History View
    const HistoryView = () => {
        return (
            <>
                <h2 className="text-2xl font-bold text-gray-800 mb-6 flex items-center">
                    <i className="fas fa-calendar-check mr-2 text-indigo-600"></i> Daily Score History
                </h2>
                
                <p className="text-sm text-gray-600 mb-4">A record of your scores and goal achievements for each day's cleanup.</p>
                
                <div className="history-list-container space-y-3 max-h-[500px] overflow-y-auto pr-2">
                    {scoreHistory.length === 0 ? (
                        <p className="text-center text-gray-500 py-6">No recorded scores yet. Complete a Daily Task Clean-up to save your first score!</p>
                    ) : (
                        scoreHistory.map(item => {
                            const date = item.date?.toDate ? item.date.toDate().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unknown Date';
                            const score = item.score || 0;
                            const goalAchieved = item.goalAchieved;
                            const goal = item.dailyGoal || 0;
            
                            const icon = goalAchieved ? <i className="fas fa-trophy text-yellow-500 mr-2"></i> : <i className="fas fa-times-circle text-red-500 mr-2"></i>;
                            const colorClass = goalAchieved ? 'bg-green-50 border-green-300' : 'bg-red-50 border-red-300';
                            const textClass = goalAchieved ? 'text-green-800' : 'text-red-800';

                            return (
                                <div key={item.id} className={`flex flex-col sm:flex-row justify-between items-start sm:items-center p-4 rounded-xl shadow-md border ${colorClass} transition duration-150 hover:shadow-lg`}>
                                    <div className="flex flex-col mb-2 sm:mb-0">
                                        <span className="text-sm font-semibold text-gray-700 whitespace-nowrap">{date}</span>
                                        <span className={`text-xs font-medium ${textClass} flex items-center mt-1`}>
                                            {icon} Daily Goal: {goalAchieved ? 'Achieved' : 'Missed'} (Target: {goal} pts)
                                        </span>
                                    </div>
                                    <div className="text-2xl font-extrabold text-indigo-600 flex items-center">
                                        {score} <span className="text-base font-semibold ml-1 text-gray-600">pts</span>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </>
        );
    };

    // --- MODALS ---

    const GoalModal = () => {
        const [target, setTarget] = useState(goals[uiState.currentPeriod] > 0 ? goals[uiState.currentPeriod] : '');
        const [frequency, setFrequency] = useState(uiState.currentPeriod);

        useEffect(() => {
            // Update internal state when modal opens/changes period view
            setFrequency(uiState.currentPeriod);
            setTarget(goals[uiState.currentPeriod] > 0 ? goals[uiState.currentPeriod] : '');
        }, [uiState.currentPeriod, goals]);


        const handleSave = () => {
            const newGoal = parseInt(target, 10);
            
            if (newGoal > 0 && frequency) {
                 if (frequency === 'daily' && newGoal < MIN_RECOMMENDED_DAILY_GOAL) {
                    showMessage(
                        "Set a High-Impact Daily Target", 
                        `<p>Your current goal is <strong>${newGoal} points</strong>. To build <strong>High-Impact Momentum</strong>, we strongly recommend setting your Daily Target to at least <strong>${MIN_RECOMMENDED_DAILY_GOAL} points</strong>.</p>`,
                        'text-yellow-600'
                    );
                }
                saveGoal(newGoal, frequency);
                setModalOpen(null);
                setUiState(prev => ({ ...prev, currentPeriod: frequency })); // Switch view to the set goal
            }
        };

        const placeholderText = frequency === 'daily' 
            ? `${MIN_RECOMMENDED_DAILY_GOAL} (Recommended Minimum)` 
            : frequency === 'weekly' ? '150' : frequency === 'monthly' ? '600' : '7500';

        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                <div className="bg-white p-6 rounded-xl shadow-2xl w-full max-w-sm">
                    <h3 className="text-xl font-semibold mb-4 text-gray-800">Set Target Score</h3>
                    <p className="text-sm text-gray-600 mb-4">Choose a frequency and set a score target.</p>
                    
                    <select value={frequency} onChange={(e) => setFrequency(e.target.value)}
                            className="w-full p-3 border border-gray-300 rounded-lg mb-3 bg-white focus:ring-indigo-500 focus:border-indigo-500">
                        <option value="daily">Daily Goal</option>
                        <option value="weekly">Weekly Goal</option>
                        <option value="monthly">Monthly Goal</option>
                        <option value="yearly">Yearly Goal</option> 
                    </select>
                    
                    <input type="number" placeholder={`E.g., ${placeholderText}`} min="1"
                           value={target}
                           onChange={(e) => setTarget(e.target.value)}
                           className="w-full p-3 border border-gray-300 rounded-lg mb-4 focus:ring-indigo-500 focus:border-indigo-500"/>
                    <div className="flex justify-end space-x-3">
                        <button onClick={() => setModalOpen(null)} className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition duration-150">Cancel</button>
                        <button onClick={handleSave} className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition duration-150">Save Goal</button>
                    </div>
                </div>
            </div>
        );
    };

    const ResetModal = () => {
        const [deleteIncomplete, setDeleteIncomplete] = useState(false);
        
        const handleConfirm = async () => {
            setModalOpen(null);
            const deleteCompleted = true; // Always true for daily cleanup
            await resetTasks(deleteCompleted, deleteIncomplete);
            setDeleteIncomplete(false); // Reset state after action
        };

        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
                <div className="bg-white p-6 rounded-xl shadow-2xl w-full max-w-lg">
                    <h3 className="text-2xl font-bold mb-4 text-gray-800 flex items-center">
                        <i className="fas fa-trash-alt text-red-500 mr-2"></i> Daily Task Cleanup
                    </h3>
                    <p className="text-gray-700 mb-4">This action will clear your current task list to prepare for a new day. Please choose what to remove:</p>
                    
                    <div className="space-y-3 mb-6">
                        {/* Option 1: Delete ALL Completed Tasks (Always checked) */}
                        <div className="flex items-center p-3 bg-green-50 rounded-lg border border-green-200">
                            <input type="checkbox" checked disabled className="h-5 w-5 text-green-600 border-gray-300 rounded focus:ring-green-500 mr-3"/>
                            <label className="font-semibold text-green-700">Remove ALL <span className="font-bold">Completed Tasks</span></label>
                        </div>

                        {/* Option 2: Delete ALL Incomplete Tasks */}
                        <div className="flex items-center p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                            <input type="checkbox" checked={deleteIncomplete} onChange={(e) => setDeleteIncomplete(e.target.checked)}
                                   className="h-5 w-5 text-yellow-600 border-gray-300 rounded focus:ring-yellow-500 mr-3"/>
                            <label className="font-semibold text-yellow-700">Remove ALL <span className="font-bold">Incomplete Tasks</span> (Start completely fresh)</label>
                        </div>
                        
                        <p className="text-sm text-indigo-700 bg-indigo-50 p-3 rounded-lg border border-indigo-200 font-medium">
                            <i className="fas fa-info-circle mr-1"></i> Your final score of <span className="font-extrabold">{dailyScore}</span> points will be saved to your history before tasks are cleared.
                        </p>
                    </div>

                    <div className="flex justify-end space-x-3">
                        <button onClick={() => setModalOpen(null)} className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition duration-150">Cancel</button>
                        <button onClick={handleConfirm} className="px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 transition duration-150">Confirm Cleanup</button>
                    </div>
                </div>
            </div>
        );
    };
    
    const MasterResetModal = () => (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white p-6 rounded-xl shadow-2xl w-full max-w-lg border-t-8 border-red-500">
                <h3 className="text-2xl font-bold mb-4 text-gray-800 flex items-center">
                    <i className="fas fa-triangle-exclamation text-red-500 mr-2"></i> CONFIRM DATA DELETION
                </h3>
                <p className="text-red-700 bg-red-100 p-3 rounded-lg font-semibold mb-4">
                    <i className="fas fa-skull-crossbones mr-1"></i> This is a permanent action.
                </p>
                <p className="text-gray-700 mb-6">Are you absolutely sure you want to perform a <strong>MASTER RESET</strong>?</p>
                 <p className="text-gray-700 mb-6 font-bold">This action will permanently delete:</p>

                <ul className="list-disc list-inside space-y-2 mb-6 ml-4 text-gray-600">
                    <li><strong className="text-red-600">All Current Tasks</strong> (Pending and Completed)</li>
                    <li><strong className="text-red-600">All Score History Records</strong></li>
                    <li><strong className="text-red-600">All Saved Goals</strong> (Daily, Weekly, Monthly, Yearly)</li>
                </ul>

                <div className="flex justify-end space-x-3">
                    <button onClick={() => setModalOpen(null)} className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition duration-150">Cancel</button>
                    <button onClick={() => { setModalOpen(null); masterReset(); }} 
                            className="px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 transition duration-150">
                        YES, Delete All Data
                    </button>
                </div>
            </div>
        </div>
    );

    const MessageBox = () => (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white p-6 rounded-xl shadow-2xl w-full max-w-sm">
                <h3 className="text-xl font-semibold mb-3 text-gray-800 flex items-center" 
                    dangerouslySetInnerHTML={{ __html: `<i class="fas fa-info-circle mr-2 ${uiState.message.colorClass}"></i> ${uiState.message.title}` }}>
                </h3>
                <p className="text-gray-700 mb-4" dangerouslySetInnerHTML={{ __html: uiState.message.content }}></p>
                <div className="flex justify-end">
                    <button onClick={() => setUiState(prev => ({ ...prev, message: null }))} className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition duration-150">Got It</button>
                </div>
            </div>
        </div>
    );
    
    // --- RENDER FUNCTION ---
    
    return (
        <div className="w-full max-w-2xl bg-white shadow-xl rounded-3xl p-0 sm:p-0">
            <style>
                {`
                    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
                    body { font-family: 'Inter', sans-serif; background-color: #f7f7f9; }
                    .task-list-container::-webkit-scrollbar, .history-list-container::-webkit-scrollbar { width: 8px; }
                    .task-list-container::-webkit-scrollbar-thumb, .history-list-container::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 4px; }
                    .header-gradient { background: linear-gradient(to right, #4f46e5, #4338ca); }
                    .bg-budget-ok { background-color: #10b981; }
                    .bg-budget-warning { background-color: #f59e0b; }
                    .bg-budget-critical { background-color: #ef4444; }
                `}
            </style>
            
            {/* Header */}
            <header className="header-gradient text-white p-6 rounded-t-3xl shadow-lg mb-6">
                <h1 className="text-3xl font-extrabold flex items-center">
                    <i className="fas fa-chart-line mr-3 text-indigo-200"></i>
                    SCORE TRACKER
                </h1>
                <p className="text-xs text-indigo-200 mt-1">User ID: {userId}</p>
            </header>
            
            <div className="p-6 pt-0">
                {/* View Toggle Navigation */}
                <section className="mb-6 flex space-x-3 p-1 bg-gray-100 rounded-xl shadow-inner">
                    <button 
                        onClick={() => setUiState(prev => ({ ...prev, currentView: 'tracker' }))}
                        className={`flex-1 py-3 px-4 rounded-xl font-bold transition duration-150 ${uiState.currentView === 'tracker' ? 'bg-white text-indigo-700 shadow-md' : 'text-gray-700 hover:bg-gray-200'}`}>
                        <i className="fas fa-list-check mr-2"></i> Current Tasks
                    </button>
                    <button 
                        onClick={() => setUiState(prev => ({ ...prev, currentView: 'history' }))}
                        className={`flex-1 py-3 px-4 rounded-xl font-bold transition duration-150 ${uiState.currentView === 'history' ? 'bg-white text-indigo-700 shadow-md' : 'text-gray-700 hover:bg-gray-200'}`}>
                        <i className="fas fa-history mr-2"></i> Score History
                    </button>
                </section>

                {/* Main Content Area */}
                {uiState.currentView === 'tracker' ? <TrackerView /> : <HistoryView />}
            </div>
            
            {/* Modals */}
            {modalOpen === 'goal' && <GoalModal />}
            {modalOpen === 'reset' && <ResetModal />}
            {modalOpen === 'masterReset' && <MasterResetModal />}
            
            {/* Message Box */}
            {uiState.message && <MessageBox />}
            
        </div>
    );
}
