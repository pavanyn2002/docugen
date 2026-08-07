import React, { lazy } from 'react';
import ProtectedRoute from './ProtectedRoute.js';

const Home = lazy(() => import('./views/Home.jsx'));
const Profile = lazy(() => import('./views/Profile.jsx'));
const Billing = lazy(() => import('./views/Billing.jsx'));

const routes = [
  { path: '/', element: <Home />, exact: true },
  { path: '/profile', element: <Profile /> },
  { path: '/billing', element: <ProtectedRoute><Billing /></ProtectedRoute> },
  { path: '*', element: <Home /> },
];

export default routes;
