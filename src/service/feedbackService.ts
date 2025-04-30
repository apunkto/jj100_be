import {Env} from "../index"
import {getSupabaseClient} from "../supabase"

export type FeedbackRow = {
    id: number
    score: number
    feedback: string
}

export const submitFeedback = async (
    env: Env,
    score: number,
    feedback: string
) => {
    const supabase = getSupabaseClient(env)

    const { data, error } = await supabase.from("feedback").insert([
        {
            score,
            feedback
        }
    ])

    return { data, error }
}