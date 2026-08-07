import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import routes from './routeTable.jsx';
import { navigation } from './navigation.js';

export function AppShell() {
  return (
    <Router>
      <Routes>
        {routes.map(({ path, element }, index) => (
          <Route key={index} path={path} element={element} />
        ))}
      </Routes>
    </Router>
  );
}
