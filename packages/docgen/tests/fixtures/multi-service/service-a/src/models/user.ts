import mongoose, { Schema } from 'mongoose';
const UserSchema = new Schema({ email: String });
mongoose.model('User', UserSchema);
