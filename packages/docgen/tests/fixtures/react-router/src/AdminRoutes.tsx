import { Route, Routes } from 'react-router-dom';
import Users from './Users';
import UserDetail from './UserDetail';

export function AdminRoutes() {
  return (
    <Routes>
      <Route path="/admin" element={<Users />}>
        <Route path="users" element={<Users />} />
        <Route path="users/:userId" element={<UserDetail />} />
      </Route>
    </Routes>
  );
}
