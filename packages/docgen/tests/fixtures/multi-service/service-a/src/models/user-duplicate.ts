import mongoose, { Schema } from 'mongoose';
const UserSchema = new Schema({ displayName: String });
mongoose.model('User', UserSchema);
